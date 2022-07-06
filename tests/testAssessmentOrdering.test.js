// @ts-check
const util = require('util');
const assert = require('chai').assert;
const { step } = require('mocha-steps');
const { v4: uuid } = require('uuid');

const config = require('../lib/config');
const sqldb = require('../prairielib/sql-db');
const sqlLoader = require('../prairielib/sql-loader');
const sql = sqlLoader.loadSqlEquiv(__filename);

const helperServer = require('./helperServer');
const helperClient = require('./helperClient');
const { getCourseData, COURSE_INSTANCE_ID, writeCourseToTempDirectory } = require('./sync/util');

describe('Course with assessments grouped by Set vs Module', function () {
  this.timeout(60000);

  const context = {};
  context.courseDir = null;
  context.siteUrl = `http://localhost:${config.serverPort}`;
  context.baseUrl = `${context.siteUrl}/pl`;
  context.courseInstanceBaseUrl = `${context.baseUrl}/course_instance/1`;
  context.assessmentsUrl = `${context.courseInstanceBaseUrl}/assessments`;

  const course = getCourseData();
  course.courseInstances[COURSE_INSTANCE_ID].assessments = {
    'homework-1': {
      uuid: uuid(),
      title: 'Homework 1',
      type: 'Homework',
      set: 'Exams',
      module: 'Module 1',
      number: '1',
    },
    'exam-1': {
      uuid: uuid(),
      title: 'Exam 1',
      type: 'Exam',
      set: 'Exams',
      module: 'Module 1',
      number: '1',
    },
  };

  async function fetchAssessmentsPage() {
    const response = await helperClient.fetchCheerio(context.assessmentsUrl);
    assert.isTrue(response.ok);
    return response;
  }

  function testHeadingOrder(response, assessmentHeadings) {
    const headings = response.$('table th[data-testid="assessment-group-heading"]');
    assert.lengthOf(
      headings,
      assessmentHeadings.length,
      'If you recently added a new assessment to the testCourse, you need to set "module":"misc".'
    );
    headings.each((i, heading) => {
      let headingText = response.$(heading).text();
      assert(
        headingText.includes(assessmentHeadings[i]),
        `expected ${headingText} to include ${assessmentHeadings[i]}`
      );
    });
  }

  function extractAssessmentSetBadgeText(response) {
    const badgeText = [];
    response.$('table [data-testid="assessment-set-badge"]').each((i, badge) => {
      badgeText.push(response.$(badge).text().trim());
    });
    return badgeText;
  }

  before('set up testing server', async function () {
    context.courseDir = await writeCourseToTempDirectory(course);
    await util.promisify(helperServer.before(context.courseDir).bind(this))();
  });
  after('shut down testing server', helperServer.after);

  step('should default to grouping by Set', async function () {
    const result = await sqldb.queryOneRowAsync(sql.get_test_course, []);
    assert.equal(result.rows[0].assessments_group_by, 'Set');
  });

  step('should use correct order when grouping by Set', async function () {
    const response = await fetchAssessmentsPage();

    const setHeadings = ['Homeworks', 'Exams'];
    testHeadingOrder(response, setHeadings);

    // save list of assessment badges to compare to future values
    context.assessmentBadges = extractAssessmentSetBadgeText(response);
  });

  step('should use correct order when grouping by Module', async function () {
    const result = await sqldb.queryOneRowAsync(sql.test_course_assessments_group_by_module, []);
    assert(result.rows[0].id === 1);

    const response = await fetchAssessmentsPage();

    const moduleHeadings = [
      'Intro to PrairieLearn',
      'Examination with proctors',
      'Alternate grading techniques',
      'Working with partners',
      'Miscellaneous assessments',
    ];
    testHeadingOrder(response, moduleHeadings);

    const badges = extractAssessmentSetBadgeText(response);

    // only check the order for the first 3 modules,
    // to avoid breaking this test every time a new assessment gets added.
    const expectedBadges = [
      // intro
      'HW1',
      'HW2',
      'E1',
      'E2',
      // cbtf
      'E3',
      'E4',
      // grading
      'HW3',
      'HW4',
      'E5',
      'E6',
      'E7',
      'E8',
    ];
    assert.sameOrderedMembers(
      badges.slice(0, expectedBadges.length),
      expectedBadges,
      'First three modules have assessments in expected order'
    );

    // compare this new set of badges with the old one
    assert.sameMembers(
      badges,
      context.assessmentBadges,
      'Assessments are consistent between assessments_group_by=Set and assessments_group_by=Module'
    );
  });
});
