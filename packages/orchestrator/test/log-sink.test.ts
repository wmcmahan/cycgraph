/**
 * Injectable log sink: entries route to a host transport instead of the
 * process streams, per run rather than globally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, type Span, type SpanContext } from '@opentelemetry/api';
import { createLogger, runWithContext } from '../src/index.js';
import { resetLogLevelCache } from '../src/observability/logger.js';
import type { LogEntry } from '../src/index.js';

describe('log sink', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.LOG_LEVEL = 'info';
    resetLogLevelCache();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    resetLogLevelCache();
  });

  it('sends entries to the sink instead of the process streams', async () => {
    const received: LogEntry[] = [];

    await runWithContext({ run_id: 'r1', logger: (e) => received.push(e) }, async () => {
      createLogger('test').info('hello', { k: 'v' });
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('test.hello');
    expect(received[0].context).toMatchObject({ run_id: 'r1', k: 'v' });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('routes errors to the sink too, not to stderr', async () => {
    const received: LogEntry[] = [];

    await runWithContext({ logger: (e) => received.push(e) }, async () => {
      createLogger('test').error('boom');
    });

    expect(received[0].level).toBe('error');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('falls back to the process streams with no sink installed', async () => {
    await runWithContext({ run_id: 'r1' }, async () => {
      createLogger('test').info('hello');
    });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('respects LOG_LEVEL, so the sink never sees filtered entries', async () => {
    const received: LogEntry[] = [];
    process.env.LOG_LEVEL = 'warn';
    resetLogLevelCache();

    await runWithContext({ logger: (e) => received.push(e) }, async () => {
      createLogger('test').info('filtered');
      createLogger('test').warn('kept');
    });

    expect(received.map((e) => e.level)).toEqual(['warn']);
  });

  it('does not let a throwing sink fail the caller', async () => {
    await expect(
      runWithContext({ logger: () => { throw new Error('transport down'); } }, async () => {
        createLogger('test').info('hello');
        return 'completed';
      }),
    ).resolves.toBe('completed');
  });

  it('reports a throwing sink once on stderr rather than swallowing it', async () => {
    await runWithContext({ logger: () => { throw new Error('down'); } }, async () => {
      createLogger('test').info('hello');
    });

    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(written).event).toBe('logger.sink_failed');
  });

  it('keeps concurrent runs on their own sinks', async () => {
    const a: string[] = [];
    const b: string[] = [];

    await Promise.all([
      runWithContext({ run_id: 'a', logger: (e) => a.push(e.event) }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        createLogger('run').info('from_a');
      }),
      runWithContext({ run_id: 'b', logger: (e) => b.push(e.event) }, async () => {
        createLogger('run').info('from_b');
      }),
    ]);

    expect(a).toEqual(['run.from_a']);
    expect(b).toEqual(['run.from_b']);
  });

  it('leaves entries emitted outside any run on the process streams', () => {
    createLogger('test').error('outside');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GraphRunner logger option', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.env.LOG_LEVEL = 'info';
    resetLogLevelCache();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    resetLogLevelCache();
  });

  it('routes a whole run through the injected sink', async () => {
    const { graph, router, state, GraphRunner } = await import('../src/index.js');
    const received: LogEntry[] = [];
    const g = graph({ name: 'quiet', nodes: [router({ id: 'only' })], startNode: 'only', endNodes: ['only'] });

    const runner = new GraphRunner(g, state({ workflowId: g.id, goal: 'run' }), {
      logger: (e) => received.push(e),
    });
    await runner.run();

    expect(received.length).toBeGreaterThan(0);
    expect(received.every((e) => e.context?.run_id !== undefined)).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes to stdout when no logger is given', async () => {
    const { graph, router, state, GraphRunner } = await import('../src/index.js');
    const g = graph({ name: 'loud', nodes: [router({ id: 'only' })], startNode: 'only', endNodes: ['only'] });

    await new GraphRunner(g, state({ workflowId: g.id, goal: 'run' })).run();

    expect(stdoutSpy).toHaveBeenCalled();
  });
});

describe('trace correlation', () => {
  const TRACE_ID = '5212e9fd52676b9150b254a1ff27fdfb';
  const SPAN_ID = 'a3aec6efac8647b9';

  /** A span whose context is whatever the test needs it to be. */
  const spanWith = (spanContext: SpanContext): Span =>
    ({ spanContext: () => spanContext }) as Span;

  const capture = (): LogEntry[] => {
    const received: LogEntry[] = [];
    runWithContext({ logger: (e) => received.push(e) }, () => {
      createLogger('probe').info('emitted');
    });
    return received;
  };

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.env.LOG_LEVEL = 'info';
    resetLogLevelCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    resetLogLevelCache();
  });

  it('omits trace ids when no span is active', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    const [entry] = capture();

    expect({ trace_id: entry?.trace_id, span_id: entry?.span_id })
      .toEqual({ trace_id: undefined, span_id: undefined });
  });

  it('stamps the active span onto the entry', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      spanWith({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
    );

    const [entry] = capture();

    expect({ trace_id: entry?.trace_id, span_id: entry?.span_id })
      .toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID });
  });

  it('omits the all-zero ids of a span that is not recording', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      spanWith({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
    );

    const [entry] = capture();

    expect({ trace_id: entry?.trace_id, span_id: entry?.span_id })
      .toEqual({ trace_id: undefined, span_id: undefined });
  });
});
