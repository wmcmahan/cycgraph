/**
 * Tests for budget/counter — token counting across prompt segments.
 */

import { describe, it, expect } from 'vitest';
import { createTokenCounter, countSegmentTokens, countTotalTokens } from '../src/budget/counter.js';
import type { TokenCounter } from '../src/providers/types.js';
import { seg } from './helpers.js';

describe('createTokenCounter', () => {
  it('returns a working default counter when no provider is given', () => {
    const counter = createTokenCounter();
    expect(counter.countTokens('hello')).toBeGreaterThan(0);
  });

  it('returns the custom provider unchanged when one is given', () => {
    const custom: TokenCounter = { countTokens: () => 42 };
    const counter = createTokenCounter(custom);
    expect(counter.countTokens('anything')).toBe(42);
  });
});

describe('countSegmentTokens', () => {
  const counter: TokenCounter = { countTokens: (t: string) => t.length };

  it('maps each segment id to its token count', () => {
    const counts = countSegmentTokens([seg('a', 'ab'), seg('b', 'cde')], counter);
    expect([...counts.entries()]).toEqual([
      ['a', 2],
      ['b', 3],
    ]);
  });

  it('forwards the model to the counter', () => {
    const modelAware: TokenCounter = {
      countTokens: (_t, model) => (model === 'big' ? 100 : 1),
    };
    const counts = countSegmentTokens([seg('a', 'x')], modelAware, 'big');
    expect(counts.get('a')).toBe(100);
  });

  it('returns an empty map for no segments', () => {
    expect(countSegmentTokens([], counter).size).toBe(0);
  });
});

describe('countTotalTokens', () => {
  const counter: TokenCounter = { countTokens: (t: string) => t.length };

  it('sums the per-segment counts', () => {
    const total = countTotalTokens([seg('a', 'ab'), seg('b', 'cde')], counter);
    expect(total).toBe(5);
  });

  it('returns 0 for no segments', () => {
    expect(countTotalTokens([], counter)).toBe(0);
  });

  it('forwards the model to the counter', () => {
    const modelAware: TokenCounter = {
      countTokens: (_t, model) => (model === 'big' ? 10 : 1),
    };
    expect(countTotalTokens([seg('a', 'x'), seg('b', 'y')], modelAware, 'big')).toBe(20);
  });
});
