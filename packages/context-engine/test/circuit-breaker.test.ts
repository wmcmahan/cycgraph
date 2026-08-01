/**
 * Tests for budget/circuit-breaker — bypasses a stage that stops paying off.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCircuitBreaker } from '../src/budget/circuit-breaker.js';
import { createLatencyTracker } from '../src/budget/latency-tracker.js';
import type { CompressionStage } from '../src/pipeline/types.js';
import { seg, makeContext } from './helpers.js';

function compressingStage(): CompressionStage {
  return {
    name: 'test-compressor',
    execute: segments => ({
      segments: segments.map(s => ({ ...s, content: s.content.replace(/filler /g, '') })),
    }),
  };
}

function noopStage(): CompressionStage {
  return { name: 'noop-stage', execute: segments => ({ segments }) };
}

const withFiller = [seg('a', 'hello filler world filler end')];

describe('createCircuitBreaker', () => {
  it('prefixes the wrapper name with circuit-breaker', () => {
    const breaker = createCircuitBreaker(compressingStage(), createLatencyTracker());
    expect(breaker.name).toBe('circuit-breaker:test-compressor');
  });

  it('propagates the wrapped stage scope', () => {
    const tracker = createLatencyTracker();
    const cross: CompressionStage = { name: 'cross', scope: 'cross-segment', execute: s => ({ segments: s }) };

    expect(createCircuitBreaker(cross, tracker).scope).toBe('cross-segment');
    expect(createCircuitBreaker(noopStage(), tracker).scope).toBeUndefined();
  });

  it('executes the inner stage during warmup', () => {
    const tracker = createLatencyTracker();
    const breaker = createCircuitBreaker(compressingStage(), tracker, { warmupSamples: 3 });

    const result = breaker.execute(withFiller, makeContext());

    expect(result.segments[0].content).toBe('hello world end');
    expect(tracker.getAverage('test-compressor').samplesCount).toBe(1);
  });

  it('keeps executing after warmup when efficiency stays above the threshold', () => {
    const tracker = createLatencyTracker();
    const breaker = createCircuitBreaker(compressingStage(), tracker, { warmupSamples: 2, minEfficiency: 0 });

    breaker.execute(withFiller, makeContext());
    breaker.execute(withFiller, makeContext());
    const result = breaker.execute(withFiller, makeContext());

    expect(result.segments[0].content).toBe('hello world end');
    expect(tracker.getAverage('test-compressor').samplesCount).toBe(3);
  });

  it('records metrics for each executed run', () => {
    const tracker = createLatencyTracker();
    const breaker = createCircuitBreaker(compressingStage(), tracker, { warmupSamples: 1 });

    breaker.execute([seg('a', 'hello filler world')], makeContext());

    const stats = tracker.getAverage('test-compressor');
    expect(stats.samplesCount).toBe(1);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTokensSaved).toBe(1);
  });

  it('bypasses without recording once efficiency drops below the threshold', () => {
    const tracker = createLatencyTracker();
    const breaker = createCircuitBreaker(noopStage(), tracker, {
      warmupSamples: 2,
      minEfficiency: 1.0,
      cooldownMs: 60_000,
    });
    const ctx = makeContext();
    const segments = [seg('a', 'content')];

    breaker.execute(segments, ctx);
    breaker.execute(segments, ctx);
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);

    const result = breaker.execute(segments, ctx);

    expect(result.segments[0].content).toBe('content');
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);
  });

  it('stays bypassed on repeated calls within the cooldown window', () => {
    const tracker = createLatencyTracker();
    const breaker = createCircuitBreaker(noopStage(), tracker, {
      warmupSamples: 1,
      minEfficiency: 100,
      cooldownMs: 60_000,
    });
    const ctx = makeContext();
    const segments = [seg('a', 'content here')];

    breaker.execute(segments, ctx);
    breaker.execute(segments, ctx);
    const result = breaker.execute(segments, ctx);

    expect(result.segments[0].content).toBe('content here');
    expect(tracker.getAverage('noop-stage').samplesCount).toBe(1);
  });

  it('degrades gracefully and records zero savings when the inner stage throws', () => {
    const tracker = createLatencyTracker();
    const failing: CompressionStage = {
      name: 'failing-stage',
      execute() {
        throw new Error('ML model crashed');
      },
    };
    const breaker = createCircuitBreaker(failing, tracker, { warmupSamples: 1 });

    const result = breaker.execute([seg('a', 'content')], makeContext());

    expect(result.segments[0].content).toBe('content');
    const stats = tracker.getAverage('failing-stage');
    expect(stats.samplesCount).toBe(1);
    expect(stats.avgTokensSaved).toBe(0);
  });

  describe('cooldown', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries once after the cooldown elapses', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const tracker = createLatencyTracker();
      const cooldownMs = 1_000;
      const breaker = createCircuitBreaker(noopStage(), tracker, {
        warmupSamples: 2,
        minEfficiency: 1.0,
        cooldownMs,
      });
      const ctx = makeContext();
      const segments = [seg('a', 'content')];

      breaker.execute(segments, ctx);
      breaker.execute(segments, ctx);
      breaker.execute(segments, ctx);
      expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);

      vi.setSystemTime(cooldownMs);
      breaker.execute(segments, ctx);

      expect(tracker.getAverage('noop-stage').samplesCount).toBe(3);
    });

    it('keeps bypassing until the full cooldown has elapsed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const tracker = createLatencyTracker();
      const cooldownMs = 1_000;
      const breaker = createCircuitBreaker(noopStage(), tracker, {
        warmupSamples: 2,
        minEfficiency: 1.0,
        cooldownMs,
      });
      const ctx = makeContext();
      const segments = [seg('a', 'content')];

      breaker.execute(segments, ctx);
      breaker.execute(segments, ctx);
      breaker.execute(segments, ctx);

      vi.setSystemTime(cooldownMs - 1);
      breaker.execute(segments, ctx);

      expect(tracker.getAverage('noop-stage').samplesCount).toBe(2);
    });
  });
});
