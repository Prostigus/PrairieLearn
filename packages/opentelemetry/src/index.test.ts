import { tracing } from '@opentelemetry/sdk-node';
import { assert } from 'chai';

import { context, init, instrumented, shutdown, trace, SpanStatusCode } from './index';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';

describe('instrumented', () => {
  let contextManager: AsyncHooksContextManager;
  let exporter = new tracing.InMemorySpanExporter();

  before(async () => {
    await init({
      openTelemetryEnabled: true,
      openTelemetryExporter: exporter,
      openTelemetrySamplerType: 'always-on',
      openTelemetrySpanProcessor: 'simple',
    });
  });

  beforeEach(async () => {
    contextManager = new AsyncHooksContextManager();
    context.setGlobalContextManager(contextManager.enable());
  });

  afterEach(async () => {
    exporter.reset();
    context.disable();
  });

  it('returns the value from the function', async () => {
    const res = await instrumented('test', () => 'foo');
    assert.equal(res, 'foo');
  });

  it('records a span on success', async () => {
    await instrumented('test-success', () => 'foo');

    const spans = exporter.getFinishedSpans();
    assert.lengthOf(spans, 1);
    assert.equal(spans[0].name, 'test-success');
    assert.equal(spans[0].status.code, SpanStatusCode.OK);
  });

  it('records a span on failure', async () => {
    let maybeError = null;
    await instrumented('test-failure', () => {
      throw new Error('foo');
    }).catch((err) => {
      maybeError = err;
    });

    // Ensure the error was propagated back to the caller.
    assert.isOk(maybeError);
    assert.equal(maybeError.message, 'foo');

    // Ensure the correct span was recorded.
    const spans = exporter.getFinishedSpans();
    assert.lengthOf(spans, 1);
    assert.equal(spans[0].name, 'test-failure');
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
    assert.equal(spans[0].status.message, 'foo');
    assert.equal(spans[0].events[0].name, 'exception');
  });

  it('sets up context correctly', async () => {
    const tracer = trace.getTracer('default');
    const parentSpan = tracer.startSpan('parentSpan');
    const parentContext = trace.setSpan(context.active(), parentSpan);

    await instrumented('test', async () => {
      const childContext = context.active();
      assert.notStrictEqual(childContext, parentContext);
    });
  });
});
