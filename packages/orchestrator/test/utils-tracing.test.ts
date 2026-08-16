/**
 * Tests for observability/tracing: getTracer, withSpan (success/error paths),
 * initTracing (disabled early-return + enabled NodeSDK path with the OTel
 * modules mocked so no real exporter or network is involved),
 * shutdownTracing's release of the global provider, and the inject/extract
 * pair that carries a trace across a process boundary.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  type Context,
  type ContextManager,
  type TextMapPropagator,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import {
  getTracer,
  injectTraceContext,
  withRemoteTraceContext,
  withSpan,
} from '../src/observability/tracing.js';

const fakeProvider = (): TracerProvider => ({ getTracer: () => ({}) as Tracer });

const MARK = Symbol.for('test.mark');

/**
 * Propagates one field, so extraction can be observed without pulling in an
 * SDK. What a real propagator does with `traceparent`, this does with `mark`.
 */
const markPropagator = (): TextMapPropagator => ({
  inject: (ctx, carrier, setter) => {
    const mark = ctx.getValue(MARK);
    if (typeof mark === 'string') setter.set(carrier, 'mark', mark);
  },
  extract: (ctx, carrier, getter) => {
    const mark = getter.get(carrier, 'mark');
    return typeof mark === 'string' ? ctx.setValue(MARK, mark) : ctx;
  },
  fields: () => ['mark'],
});

/**
 * The minimum context manager that makes `context.with` observable.
 *
 * The API's default is a no-op, under which nothing is ever active — so
 * without this an extraction test would pass whether or not extraction worked.
 */
const syncContextManager = (): ContextManager => {
  let current: Context = ROOT_CONTEXT;
  return {
    active: () => current,
    with(ctx, fn, thisArg, ...args) {
      const previous = current;
      current = ctx;
      try {
        return fn.call(thisArg as never, ...(args as never[]));
      } finally {
        current = previous;
      }
    },
    bind: (_ctx, target) => target,
    enable() { return this; },
    disable() { current = ROOT_CONTEXT; return this; },
  } as ContextManager;
};

describe('getTracer', () => {
  it('returns a tracer with a startActiveSpan method', () => {
    const tracer = getTracer('test.component');

    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });
});

describe('withSpan', () => {
  it('returns the wrapped function result on success', async () => {
    const tracer = getTracer('test');

    const result = await withSpan(tracer, 'test.operation', async () => 42);

    expect(result).toBe(42);
  });

  it('provides a span object to the callback', async () => {
    const tracer = getTracer('test');
    let receivedSpan: unknown = null;

    await withSpan(tracer, 'test.span', async (span) => {
      receivedSpan = span;
      return null;
    });

    expect(receivedSpan).toBeDefined();
  });

  it('accepts optional initial attributes', async () => {
    const tracer = getTracer('test');

    const result = await withSpan(
      tracer,
      'test.attrs',
      async () => 'ok',
      { 'custom.attr': 'value', 'custom.count': 5 },
    );

    expect(result).toBe('ok');
  });

  it('propagates and records an Error thrown by the wrapped function', async () => {
    const tracer = getTracer('test');

    await expect(
      withSpan(tracer, 'test.failing', async () => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
  });

  it('propagates a non-Error thrown value without calling recordException', async () => {
    const tracer = getTracer('test');

    await expect(
      withSpan(tracer, 'test.string-throw', async () => {
        throw 'plain string failure';
      }),
    ).rejects.toBe('plain string failure');
  });
});

describe('initTracing', () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is not set', async () => {
    vi.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const mod = await import('../src/observability/tracing.js');

    await expect(mod.initTracing('test-service')).resolves.toBeUndefined();
  });

  it('is idempotent once initialized', async () => {
    vi.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const mod = await import('../src/observability/tracing.js');

    await mod.initTracing('test-service');
    await expect(mod.initTracing('test-service')).resolves.toBeUndefined();
  });

  it('starts a NodeSDK and registers shutdown handlers when an endpoint is set', async () => {
    vi.resetModules();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    const start = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const nodeSdkCtor = vi.fn();
    const exporterCtor = vi.fn();

    class FakeNodeSDK {
      constructor(config: unknown) {
        nodeSdkCtor(config);
      }
      start = start;
      shutdown = shutdown;
    }
    class FakeExporter {
      constructor(config: unknown) {
        exporterCtor(config);
      }
    }

    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: FakeNodeSDK }));
    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: FakeExporter }));
    vi.doMock('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: unknown) => a }));
    vi.doMock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name' }));

    const handlers = new Map<string, () => Promise<void>>();
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler as () => Promise<void>);
      return process;
    });

    const mod = await import('../src/observability/tracing.js');
    await mod.initTracing('orchestrator');

    expect(exporterCtor).toHaveBeenCalledWith({ url: 'http://localhost:4318/v1/traces' });
    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('SIGINT')).toBe(true);

    await handlers.get('SIGTERM')!();
    expect(shutdown).toHaveBeenCalledTimes(1);

    onSpy.mockRestore();
  });
});

describe('shutdownTracing', () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    trace.disable();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('releases the global provider so a later init can register a live exporter', async () => {
    vi.resetModules();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    class FakeNodeSDK {
      start = (): void => { trace.setGlobalTracerProvider(fakeProvider()); };
      shutdown = (): Promise<void> => Promise.resolve();
    }
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: FakeNodeSDK }));
    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));
    vi.doMock('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: unknown) => a }));
    vi.doMock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name' }));

    const mod = await import('../src/observability/tracing.js');
    await mod.initTracing('orchestrator');
    await mod.shutdownTracing();

    expect(trace.setGlobalTracerProvider(fakeProvider())).toBe(true);
  });

  it('does nothing when tracing was never initialized', async () => {
    vi.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const mod = await import('../src/observability/tracing.js');

    await expect(mod.shutdownTracing()).resolves.toBeUndefined();
  });
});

describe('withRemoteTraceContext', () => {
  afterEach(() => {
    context.disable();
    propagation.disable();
  });

  it('returns the callback result', () => {
    expect(withRemoteTraceContext({}, () => 42)).toBe(42);
  });

  it('runs the callback under the context the carrier carries', () => {
    context.setGlobalContextManager(syncContextManager());
    propagation.setGlobalPropagator(markPropagator());

    let seen: unknown;
    withRemoteTraceContext({ mark: 'from-parent' }, () => { seen = context.active().getValue(MARK); });

    expect(seen).toBe('from-parent');
  });

  it('leaves the context alone when the carrier holds no trace fields', () => {
    context.setGlobalContextManager(syncContextManager());
    propagation.setGlobalPropagator(markPropagator());

    let seen: unknown = 'untouched';
    withRemoteTraceContext({ PATH: '/usr/bin' }, () => { seen = context.active().getValue(MARK); });

    expect(seen).toBeUndefined();
  });

  it('round-trips what injectTraceContext produced', () => {
    context.setGlobalContextManager(syncContextManager());
    propagation.setGlobalPropagator(markPropagator());

    let carrier: Record<string, string> = {};
    context.with(context.active().setValue(MARK, 'parent-span'), () => {
      carrier = injectTraceContext({});
    });

    let seen: unknown;
    withRemoteTraceContext(carrier, () => { seen = context.active().getValue(MARK); });

    expect(seen).toBe('parent-span');
  });
});
