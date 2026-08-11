/**
 * Tests for observability/tracing: getTracer, withSpan (success/error paths), and
 * initTracing (disabled early-return + enabled NodeSDK path with the OTel
 * modules mocked so no real exporter or network is involved).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTracer, withSpan } from '../src/observability/tracing.js';

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
