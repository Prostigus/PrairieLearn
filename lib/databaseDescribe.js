// @ts-check
const ERR = require('async-stacktrace');
const async = require('async');
const pgArray = require('pg').types.arrayParser;
const chalk = require('chalk').default;
const _ = require('lodash');

const sqldb = require('../prairielib/lib/sql-db');
const sqlLoader = require('../prairielib/lib/sql-loader');
const sql = sqlLoader.loadSqlEquiv(__filename);

/**
 * will produce a description of a given database's schema. This will include
 * information about tables, enums, contraints, indices, etc.
 *
 * This functions accepts an 'options' object with various options that determine
 * how the function will run. The following properties are available on the
 * 'options' object:
 *
 * databaseName [REQUIRED]: the name of the database to describe
 * outputFormat [default: 'string']: determines how the description is formatted
 * coloredOutput [default: false]: if the output should be colored for better readability
 *
 * @param  {Object}   options  Options for this function
 * @param  {Function} callback Will receive results of an error when complete
 */
module.exports.describe = function (options, callback) {
  if (!options) return callback(new Error('options must not be null'));
  if (!options.databaseName) {
    return callback(new Error('you must specify a database name with databaseName'));
  }
  if (
    options.outputFormat &&
    !(options.outputFormat === 'string' || options.outputFormat === 'object')
  ) {
    return callback(new Error(`'${options.outputFormat}' is not a valid output format`));
  }

  var tables;
  var ignoreColumns = {};

  var output = {
    tables: {},
    enums: {},
  };

  /**
   * Optionally applies the given formatter to the text if colored output is
   * enabled.
   *
   * @param {string} text
   * @param {(s: string) => string} formatter
   * @returns {string}
   */
  function formatText(text, formatter) {
    if (options.coloredOutput) {
      return formatter(text);
    }
    return text;
  }

  async.series(
    [
      (callback) => {
        // Connect to the database
        var pgConfig = {
          user: options.postgresqlUser || 'postgres',
          database: options.databaseName,
          host: options.postgresqlHost || 'localhost',
          max: 10,
          idleTimeoutMillis: 30000,
        };
        function idleErrorHandler(err) {
          throw err;
        }
        sqldb.init(pgConfig, idleErrorHandler, function (err) {
          if (ERR(err, callback)) return;
          callback(null);
        });
      },
      (callback) => {
        // Get the names of the tables
        sqldb.query(sql.get_tables, [], (err, results) => {
          if (ERR(err, callback)) return;
          tables = results.rows;

          // Filter out ignored tables
          if (options.ignoreTables && _.isArray(options.ignoreTables)) {
            tables = _.filter(tables, (table) => options.ignoreTables.indexOf(table.name) === -1);
          }

          // Initialize output with names of tables
          if (options.outputFormat === 'string') {
            tables.forEach((table) => (output.tables[table.name] = ''));
          } else {
            tables.forEach((table) => (output.tables[table.name] = {}));
          }

          callback(null);
        });
      },
      (callback) => {
        // Transform ignored columns into a map from table names to arrays
        // of column names
        if (options.ignoreColumns && _.isArray(options.ignoreColumns)) {
          ignoreColumns = _.filter(options.ignoreColumns, (ignore) => {
            return /^[^\s.]*\.[^\s.]*$/.test(ignore);
          });
          ignoreColumns = _.reduce(
            ignoreColumns,
            (result, value) => {
              var res = /^(([^\s.]*)\.([^\s.]*))$/.exec(value);
              var table = res[2];
              var column = res[3];
              (result[table] || (result[table] = [])).push(column);
              return result;
            },
            {}
          );
        }
        callback(null);
      },
      (callback) => {
        // Get column info for each table
        async.each(
          tables,
          (table, callback) => {
            async.series(
              [
                (callback) => {
                  const params = {
                    oid: table.oid,
                  };
                  sqldb.query(sql.get_columns_for_table, params, (err, results) => {
                    if (ERR(err, callback)) return;

                    const rows = _.filter(results.rows, (row) => {
                      return (ignoreColumns[table.name] || []).indexOf(row.name) === -1;
                    });

                    if (rows.length === 0) {
                      return callback(null);
                    }

                    // Transform table info into a string, if needed
                    if (options.outputFormat === 'string') {
                      output.tables[table.name] += formatText('columns\n', chalk.underline);
                      output.tables[table.name] += rows
                        .map((row) => {
                          var rowText = formatText(`    ${row.name}`, chalk.bold);
                          rowText += ':' + formatText(` ${row.type}`, chalk.green);
                          if (row.notnull) {
                            rowText += formatText(' not null', chalk.gray);
                          }
                          if (row.default) {
                            rowText += formatText(` default ${row.default}`, chalk.gray);
                          }
                          return rowText;
                        })
                        .join('\n');
                    } else {
                      output.tables[table.name].columns = rows;
                    }
                    callback(null);
                  });
                },
                (callback) => {
                  const params = {
                    oid: table.oid,
                  };
                  sqldb.query(sql.get_indexes_for_table, params, (err, results) => {
                    if (ERR(err, callback)) return;

                    if (results.rows.length === 0) {
                      return callback(null);
                    }

                    if (options.outputFormat === 'string') {
                      if (output.tables[table.name].length !== 0) {
                        output.tables[table.name] += '\n\n';
                      }
                      output.tables[table.name] += formatText('indexes\n', chalk.underline);
                      output.tables[table.name] += results.rows
                        .map((row) => {
                          const using = row.indexdef.substring(row.indexdef.indexOf('USING '));
                          var rowText = formatText(`    ${row.name}`, chalk.bold) + ':';
                          // Primary indexes are implicitly unique, so we don't need to
                          // capture that explicitly.
                          if (row.isunique && !row.isprimary) {
                            if (!row.constraintdef || row.constraintdef.indexOf('UNIQUE') === -1) {
                              // Some unique indexes don't incldue the UNIQUE constraint
                              // as part of the constraint definition, so we need to capture
                              // that manually.
                              rowText += formatText(` UNIQUE`, chalk.green);
                            }
                          }
                          rowText += row.constraintdef
                            ? formatText(` ${row.constraintdef}`, chalk.green)
                            : '';
                          rowText += using ? formatText(` ${using}`, chalk.green) : '';
                          return rowText;
                        })
                        .join('\n');
                    } else {
                      output.tables[table.name].indexes = results.rows;
                    }
                    callback(null);
                  });
                },
                (callback) => {
                  const params = {
                    oid: table.oid,
                  };
                  sqldb.query(sql.get_foreign_key_constraints_for_table, params, (err, results) => {
                    if (ERR(err, callback)) return;

                    if (results.rows.length === 0) {
                      return callback(null);
                    }

                    if (options.outputFormat === 'string') {
                      if (output.tables[table.name].length !== 0) {
                        output.tables[table.name] += '\n\n';
                      }
                      output.tables[table.name] += formatText(
                        'foreign-key constraints\n',
                        chalk.underline
                      );
                      output.tables[table.name] += results.rows
                        .map((row) => {
                          var rowText = formatText(`    ${row.name}:`, chalk.bold);
                          rowText += formatText(` ${row.def}`, chalk.green);
                          return rowText;
                        })
                        .join('\n');
                    } else {
                      output.tables[table.name].foreignKeyConstraints = results.rows;
                    }
                    callback(null);
                  });
                },
                (callback) => {
                  const params = {
                    oid: table.oid,
                  };
                  sqldb.query(sql.get_references_for_table, params, (err, results) => {
                    if (ERR(err, callback)) return;

                    // Filter out references from ignored tables
                    let rows = results.rows;
                    if (options.ignoreTables && _.isArray(options.ignoreTables)) {
                      rows = _.filter(results.rows, (row) => {
                        return options.ignoreTables.indexOf(row.table) === -1;
                      });
                    }

                    if (rows.length === 0) {
                      return callback(null);
                    }

                    if (options.outputFormat === 'string') {
                      if (output.tables[table.name].length !== 0) {
                        output.tables[table.name] += '\n\n';
                      }
                      output.tables[table.name] += formatText('referenced by\n', chalk.underline);
                      output.tables[table.name] += rows
                        .map((row) => {
                          var rowText = formatText(`    ${row.table}:`, chalk.bold);
                          rowText += formatText(` ${row.condef}`, chalk.green);
                          return rowText;
                        })
                        .join('\n');
                    } else {
                      output.tables[table.name].references = rows;
                    }
                    callback(null);
                  });
                },
              ],
              (err) => {
                if (ERR(err, callback)) return;
                callback(null);
              }
            );
          },
          (err) => {
            if (ERR(err, callback)) return;
            callback(null);
          }
        );
      },
      (callback) => {
        // Get all enums
        sqldb.query(sql.get_enums, [], (err, results) => {
          if (ERR(err, callback)) return;

          // Filter ignored enums
          let rows = results.rows;
          if (options.ignoreEnums && _.isArray(options.ignoreEnums)) {
            rows = _.filter(results.rows, (row) => {
              return options.ignoreEnums.indexOf(row.name) === -1;
            });
          }

          if (rows.length === 0) {
            return callback(null);
          }

          rows.forEach((row) => {
            if (options.outputFormat === 'string') {
              const values = pgArray.create(row.values, String).parse();
              output.enums[row.name] = formatText(values.join(', '), chalk.gray);
            } else {
              output.enums[row.name] = pgArray.create(row.values, String).parse();
            }
          });

          callback(null);
        });
      },
      (callback) => {
        // We need to tack on a newline to everything if we're in string mode
        if (options.outputFormat === 'string') {
          output.tables = _.mapValues(output.tables, (item) => item + '\n');
          output.enums = _.mapValues(output.enums, (item) => item + '\n');
        }
        callback(null);
      },
      (callback) => {
        sqldb.close((err) => {
          if (ERR(err, callback)) return;
          callback(null);
        });
      },
    ],
    (err) => {
      if (ERR(err, callback)) return;
      callback(null, output);
    }
  );
};
