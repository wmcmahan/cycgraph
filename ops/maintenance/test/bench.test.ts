/**
 * Tests for the benchmark harness (src/bench.ts) — report parsing and
 * the noise-respecting comparison.
 */

import { describe, it, expect } from 'vitest';
import { compareBench, parseBenchJson, type BenchRow } from '../src/bench.js';

function row(id: string, hz: number, rme = 0.5): BenchRow {
  return { id, hz, rme };
}

describe('parseBenchJson', () => {
  it('flattens files and groups into rows keyed by full name', () => {
    const report = JSON.stringify({
      files: [{
        groups: [{
          fullName: 'src/reducer.bench.ts > rootReducer',
          benchmarks: [{ name: 'tiny value', hz: 1000, rme: 0.1 }],
        }],
      }],
    });

    expect(parseBenchJson(report)).toEqual([
      { id: 'src/reducer.bench.ts > rootReducer > tiny value', hz: 1000, rme: 0.1 },
    ]);
  });
});

describe('compareBench', () => {
  it('counts an improvement that clears the floor and the noise', () => {
    const result = compareBench([row('a', 1000)], [row('a', 1200)], 10);

    expect(result.improved).toHaveLength(1);
    expect(result.improved[0]!.pct).toBeCloseTo(20);
    expect(result.regressed).toHaveLength(0);
  });

  it('rejects an improvement below the floor even when beyond noise', () => {
    const result = compareBench([row('a', 1000)], [row('a', 1050)], 10);

    expect(result.improved).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('rejects an improvement inside the combined noise', () => {
    const result = compareBench([row('a', 1000, 8)], [row('a', 1100, 8)], 10);

    expect(result.improved).toHaveLength(0);
  });

  it('counts a regression beyond noise and the floor', () => {
    const result = compareBench([row('a', 1000)], [row('a', 900)], 10);

    expect(result.regressed).toHaveLength(1);
    expect(result.regressed[0]!.pct).toBeCloseTo(-10);
  });

  it('treats jitter as unchanged in both directions', () => {
    const result = compareBench(
      [row('a', 1000), row('b', 1000)],
      [row('a', 1020), row('b', 985)],
      10,
    );

    expect(result.improved).toHaveLength(0);
    expect(result.regressed).toHaveLength(0);
    expect(result.unchanged).toBe(2);
  });

  it('ignores benchmarks missing from the baseline', () => {
    const result = compareBench([row('a', 1000)], [row('a', 1000), row('new', 500)], 10);

    expect(result.improved).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });
});
