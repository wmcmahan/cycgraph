/**
 * Tests for budget/latency-tracker — rolling per-stage latency and savings.
 */

import { describe, it, expect } from 'vitest';
import { createLatencyTracker } from '../src/budget/latency-tracker.js';

describe('createLatencyTracker', () => {
  it('returns zero stats for an unrecorded stage', () => {
    const tracker = createLatencyTracker();

    const stats = tracker.getAverage('unknown');

    expect(stats).toEqual({ avgDurationMs: 0, avgTokensSaved: 0, samplesCount: 0 });
  });

  it('averages duration and savings across samples', () => {
    const tracker = createLatencyTracker();
    tracker.record('format', 10, 100);
    tracker.record('format', 20, 200);

    const stats = tracker.getAverage('format');

    expect(stats).toEqual({ avgDurationMs: 15, avgTokensSaved: 150, samplesCount: 2 });
  });

  it('reports efficiency as tokens saved per millisecond', () => {
    const tracker = createLatencyTracker();
    tracker.record('dedup', 5, 50);
    tracker.record('dedup', 5, 50);

    expect(tracker.getEfficiency('dedup')).toBe(10);
  });

  it('reports zero efficiency for a stage with no samples', () => {
    const tracker = createLatencyTracker();
    expect(tracker.getEfficiency('fast')).toBe(0);
  });

  it('reports negative efficiency when a stage adds tokens', () => {
    const tracker = createLatencyTracker();
    tracker.record('bad-stage', 10, -5);

    expect(tracker.getEfficiency('bad-stage')).toBe(-0.5);
  });

  it('drops the oldest samples beyond the window size', () => {
    const tracker = createLatencyTracker(3);
    tracker.record('stage', 10, 100);
    tracker.record('stage', 20, 200);
    tracker.record('stage', 30, 300);
    tracker.record('stage', 40, 400);

    const stats = tracker.getAverage('stage');

    expect(stats).toEqual({ avgDurationMs: 30, avgTokensSaved: 300, samplesCount: 3 });
  });

  it('tracks each stage independently', () => {
    const tracker = createLatencyTracker();
    tracker.record('fast', 2, 10);
    tracker.record('slow', 100, 500);

    expect(tracker.getAverage('fast').avgDurationMs).toBe(2);
    expect(tracker.getAverage('slow').avgDurationMs).toBe(100);
  });

  it('clears all samples on reset', () => {
    const tracker = createLatencyTracker();
    tracker.record('stage', 10, 100);

    tracker.reset();

    expect(tracker.getAverage('stage').samplesCount).toBe(0);
  });
});
