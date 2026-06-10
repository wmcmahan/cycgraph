/**
 * memory-differ.test.ts — computeMemoryDiff (incl. apply round-trip)
 */
import { describe, test, expect } from 'vitest';
import { computeMemoryDiff } from '../src/runner/memory-differ.js';
import type { MemoryDiff } from '../src/runner/stream-events.js';

/** Reconstruct `after` by applying a diff to `before` — the inverse of computeMemoryDiff. */
function applyDiff(before: Record<string, unknown>, diff: MemoryDiff | undefined): Record<string, unknown> {
  if (!diff) return { ...before };
  const out = { ...before };
  for (const k of diff.added) out[k] = diff.values[k];
  for (const k of diff.changed) out[k] = diff.values[k];
  for (const k of diff.removed) delete out[k];
  return out;
}

describe('computeMemoryDiff', () => {
  test('returns undefined when nothing changed', () => {
    const m = { a: 1, b: 'x' };
    expect(computeMemoryDiff(m, { ...m })).toBeUndefined();
  });

  test('detects added, changed, and removed keys', () => {
    const before = { keep: 1, change: 'old', drop: true };
    const after = { keep: 1, change: 'new', add: [1, 2] };
    const diff = computeMemoryDiff(before, after)!;
    expect(diff.added).toEqual(['add']);
    expect(diff.changed).toEqual(['change']);
    expect(diff.removed).toEqual(['drop']);
    expect(diff.values).toEqual({ add: [1, 2], change: 'new' });
  });

  test('referentially-equal value is not reported as changed', () => {
    const shared = { nested: true };
    expect(computeMemoryDiff({ x: shared }, { x: shared })).toBeUndefined();
  });

  describe('apply round-trip: applyDiff(before, diff) === after', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['add only', { a: 1 }, { a: 1, b: 2 }],
      ['change only', { a: 1 }, { a: 99 }],
      ['remove only', { a: 1, b: 2 }, { a: 1 }],
      ['mixed', { a: 1, b: 2, c: 3 }, { a: 1, b: 20, d: 4 }],
      ['empty → populated', {}, { a: 1, b: 2 }],
      ['populated → empty', { a: 1, b: 2 }, {}],
      ['no change', { a: 1 }, { a: 1 }],
      ['falsy values', { a: 0, b: '', c: false }, { a: 0, b: 'set', c: false, d: null }],
    ];

    for (const [name, before, after] of cases) {
      test(name, () => {
        const diff = computeMemoryDiff(before, after);
        expect(applyDiff(before, diff)).toEqual(after);
      });
    }
  });
});
