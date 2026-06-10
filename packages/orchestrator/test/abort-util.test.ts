/**
 * abort-util.test.ts — combineAbortSignals
 */
import { describe, test, expect } from 'vitest';
import { combineAbortSignals } from '../src/utils/abort.js';

describe('combineAbortSignals', () => {
  test('returns undefined when no signals are given', () => {
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  test('returns the single signal unchanged when only one is present', () => {
    const c = new AbortController();
    expect(combineAbortSignals(c.signal, undefined)).toBe(c.signal);
    expect(combineAbortSignals(undefined, c.signal)).toBe(c.signal);
  });

  test('aborts when the first signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal)!;
    expect(combined.aborted).toBe(false);
    a.abort();
    expect(combined.aborted).toBe(true);
  });

  test('aborts when the second signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal)!;
    b.abort();
    expect(combined.aborted).toBe(true);
  });

  test('is already aborted if an input is pre-aborted', () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    expect(combineAbortSignals(a.signal, b.signal)!.aborted).toBe(true);
  });
});
