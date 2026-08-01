/**
 * Unit tests for createTiktokenCounter (providers/tiktoken-adapter):
 * BPE-length counting with a bounded LRU memoization cache.
 */

import { describe, it, expect } from 'vitest';

import { createTiktokenCounter } from '../src/providers/tiktoken-adapter.js';

const encodeByWord = (text: string): number[] =>
  text.split(/\s+/).filter(w => w.length > 0).map((_, i) => i);

describe('createTiktokenCounter', () => {
  it('counts tokens as the length of the encoded array', () => {
    const counter = createTiktokenCounter(encodeByWord);

    expect(counter.countTokens('hello world foo')).toBe(3);
    expect(counter.countTokens('one two three four five')).toBe(5);
  });

  it('returns 0 for an empty string without calling encode', () => {
    let calls = 0;
    const counter = createTiktokenCounter(text => { calls++; return encodeByWord(text); });

    expect(counter.countTokens('')).toBe(0);
    expect(calls).toBe(0);
  });

  it('encodes each unique text only once when memoizing', () => {
    let calls = 0;
    const counter = createTiktokenCounter(text => { calls++; return encodeByWord(text); });

    counter.countTokens('hello world');
    counter.countTokens('hello world');
    counter.countTokens('hello world');

    expect(calls).toBe(1);
  });

  it('evicts the least-recently-used entry beyond cacheSize', () => {
    let calls = 0;
    const counter = createTiktokenCounter(
      text => { calls++; return [text.length]; },
      { cacheSize: 2 },
    );

    counter.countTokens('a');
    counter.countTokens('b');
    counter.countTokens('a');
    counter.countTokens('c');
    expect(calls).toBe(3);

    counter.countTokens('a');
    expect(calls).toBe(3);

    counter.countTokens('b');
    expect(calls).toBe(4);
  });

  it('re-encodes every call when cacheSize is 0', () => {
    let calls = 0;
    const counter = createTiktokenCounter(() => { calls++; return [1]; }, { cacheSize: 0 });

    counter.countTokens('x');
    counter.countTokens('x');

    expect(calls).toBe(2);
  });
});
