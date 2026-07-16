import { describe, it, expect, vi } from 'vitest';
import { createCircuitBreaker } from '../src/budget/circuit-breaker.js';
import { createLatencyTracker } from '../src/budget/latency-tracker.js';
import type { CompressionStage, PromptSegment, BudgetConfig, StageContext } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

function makeContext(): StageContext {
  return {
    tokenCounter: counter,
    budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
  };
}

// Stage that removes "filler" text (simulates compression)
function makeCompressingStage(): CompressionStage {
  return {
    name: 'test-compressor',
    execute(segments) {
      return {
        segments: segments.map(s => ({
          ...s,
          content: s.content.replace(/filler /g, ''),
        })),
      };
    },
  };
}

// Stage that does nothing (simulates expensive but useless ML)
function makeNoopStage(): CompressionStage {
  return {
    name: 'noop-stage',
    execute(segments) {
      return { segments };
    },
  };
}

describe('createCircuitBreaker', () => {
  it('propagates the wrapped stage scope', () => {
    const tracker = createLatencyTracker();
    const crossStage: CompressionStage = {
      name: 'cross',
      scope: 'cross-segment',
      execute: segments => ({ segments }),
    };

    // Losing scope would make the incremental pipeline run a wrapped
    // cross-segment stage on the fresh subset only.
    expect(createCircuitBreaker(crossStage, tracker).scope).toBe('cross-segment');
    expect(createCircuitBreaker(makeNoopStage(), tracker).scope).toBeUndefined();
  });

  it('executes inner stage during warmup period', () => {
    const tracker = createLatencyTracker();
    const inner = makeCompressingStage();
    const breaker = createCircuitBreaker(inner, tracker, { warmupSamples: 3 });

    const segments = [makeSegment('a', 'hello filler world filler end')];
    const result = breaker.execute(segments, makeContext());

    expect(result.segments[0].content).toBe('hello world end');
    expect(tracker.getAverage('test-compressor').samplesCount).toBe(1);
  });

  it('continues executing when efficiency is above threshold', () => {
    const tracker = createLatencyTracker();
    const inner = makeCompressingStage();
    const breaker = createCircuitBreaker(inner, tracker, { warmupSamples: 2, minEfficiency: 0 });

    const segments = [makeSegment('a', 'hello filler world filler end')];

    // Warmup
    breaker.execute(segments, makeContext());
    breaker.execute(segments, makeContext());

    // After warmup — efficiency > 0
    const result = breaker.execute(segments, makeContext());
    expect(result.segments[0].content).toBe('hello world end');
  });

  it('bypasses immediately when efficiency drops below threshold', () => {
    const tracker = createLatencyTracker();
    const inner = makeNoopStage(); // saves 0 tokens
    const breaker = createCircuitBreaker(inner, tracker, {
      warmupSamples: 2,
      minEfficiency: 1.0,
      cooldownMs: 60_000, // long cooldown
    });

    const segments = [makeSegment('a', 'content')];
    const ctx = makeContext();

    // Warmup: execute twice (saves 0 tokens each time)
    breaker.execute(segments, ctx);
    breaker.execute(segments, ctx);
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);

    // After warmup: efficiency = 0 tokens/ms < 1.0 → bypass immediately
    breaker.execute(segments, ctx);
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(2); // no new sample

    // Stays bypassed
    breaker.execute(segments, ctx);
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);
  });

  it('has correct wrapper name', () => {
    const tracker = createLatencyTracker();
    const inner = makeCompressingStage();
    const breaker = createCircuitBreaker(inner, tracker);

    expect(breaker.name).toBe('circuit-breaker:test-compressor');
  });

  it('tracks metrics through the tracker', () => {
    const tracker = createLatencyTracker();
    const inner = makeCompressingStage();
    const breaker = createCircuitBreaker(inner, tracker, { warmupSamples: 1 });

    const segments = [makeSegment('a', 'hello filler world')];
    breaker.execute(segments, makeContext());

    const stats = tracker.getAverage('test-compressor');
    expect(stats.samplesCount).toBe(1);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('returns segments unchanged when bypassing', () => {
    const tracker = createLatencyTracker();
    const inner = makeNoopStage();
    const breaker = createCircuitBreaker(inner, tracker, {
      warmupSamples: 1,
      minEfficiency: 100, // impossibly high
      cooldownMs: 60_000,
    });

    const segments = [makeSegment('a', 'content here')];
    const ctx = makeContext();

    // Warmup (1 sample)
    breaker.execute(segments, ctx);

    // Bypassed immediately (efficiency < 100)
    const result = breaker.execute(segments, ctx);
    expect(result.segments[0].content).toBe('content here');
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(1); // no new sample
  });

  it('handles stage errors gracefully', () => {
    const tracker = createLatencyTracker();
    const failing: CompressionStage = {
      name: 'failing-stage',
      execute() { throw new Error('ML model crashed'); },
    };
    const breaker = createCircuitBreaker(failing, tracker, { warmupSamples: 1 });

    const segments = [makeSegment('a', 'content')];
    const ctx = makeContext();

    // Should not throw — graceful degradation
    const result = breaker.execute(segments, ctx);
    expect(result.segments[0].content).toBe('content');

    // Error recorded as 0 savings
    const stats = tracker.getAverage('failing-stage');
    expect(stats.samplesCount).toBe(1);
    expect(stats.avgTokensSaved).toBe(0);
  });
});
