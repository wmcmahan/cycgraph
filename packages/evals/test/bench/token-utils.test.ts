/**
 * Shared benchmark token-utility tests: the common token ruler, the
 * budget-aware slicer's boundary cases, and the deterministic PRNG/hash
 * used for seeded subset selection.
 */

import { describe, it, expect } from 'vitest';
import {
  countTokens,
  sliceToTokenBudget,
  mulberry32,
  hashString,
} from '../../src/bench/token-utils.js';

describe('countTokens', () => {
  it('returns 0 for an empty string and grows with length', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('a much longer piece of text')).toBeGreaterThan(countTokens('a'));
  });
});

describe('sliceToTokenBudget', () => {
  it('returns an empty string for a non-positive budget', () => {
    expect(sliceToTokenBudget('anything at all', 0)).toBe('');
    expect(sliceToTokenBudget('anything at all', -5)).toBe('');
  });

  it('returns the text unchanged when it already fits the budget', () => {
    const text = 'short text';

    expect(sliceToTokenBudget(text, 10_000)).toBe(text);
  });

  it('keeps a head prefix within budget when truncating from the tail', () => {
    const text = 'word '.repeat(200);

    const sliced = sliceToTokenBudget(text, 20);

    expect(text.startsWith(sliced)).toBe(true);
    expect(countTokens(sliced)).toBeLessThanOrEqual(20);
  });

  it('keeps a tail suffix within budget when truncating from the head', () => {
    const text = 'word '.repeat(200);

    const sliced = sliceToTokenBudget(text, 20, true);

    expect(text.endsWith(sliced)).toBe(true);
    expect(countTokens(sliced)).toBeLessThanOrEqual(20);
  });
});

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);

    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);

    expect(a()).not.toBe(b());
  });

  it('yields values in the unit interval', () => {
    const rng = mulberry32(42);

    for (let i = 0; i < 50; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashString', () => {
  it('is stable for a fixed string and unsigned', () => {
    expect(hashString('smoke-1')).toBe(hashString('smoke-1'));
    expect(hashString('smoke-1')).toBeGreaterThanOrEqual(0);
  });

  it('differs for different strings', () => {
    expect(hashString('smoke-1')).not.toBe(hashString('smoke-2'));
  });
});
