import { describe, it, expect } from 'vitest';
import { createTiktokenCounter } from '../src/providers/tiktoken-adapter.js';

describe('createTiktokenCounter', () => {
  // Mock encode function that splits on spaces (1 token per word)
  const mockEncode = (text: string): number[] =>
    text.split(/\s+/).filter(w => w.length > 0).map((_, i) => i);

  it('counts tokens using the encode function', () => {
    const counter = createTiktokenCounter(mockEncode);
    expect(counter.countTokens('hello world foo')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    const counter = createTiktokenCounter(mockEncode);
    expect(counter.countTokens('')).toBe(0);
  });

  it('works with pipeline stages', () => {
    const counter = createTiktokenCounter(mockEncode);
    // Verify it satisfies the TokenCounter interface
    expect(typeof counter.countTokens).toBe('function');
    expect(counter.countTokens('one two three four five')).toBe(5);
  });

  it('memoizes repeated texts (encode called once per unique text)', () => {
    let calls = 0;
    const counter = createTiktokenCounter(text => {
      calls++;
      return mockEncode(text);
    });

    expect(counter.countTokens('hello world')).toBe(2);
    expect(counter.countTokens('hello world')).toBe(2);
    expect(counter.countTokens('hello world')).toBe(2);
    expect(calls).toBe(1);
  });

  it('evicts least-recently-used entries beyond cacheSize', () => {
    let calls = 0;
    const counter = createTiktokenCounter(
      text => { calls++; return [text.length]; },
      { cacheSize: 2 },
    );

    counter.countTokens('a');
    counter.countTokens('b');
    counter.countTokens('a'); // refresh 'a' — 'b' is now LRU
    counter.countTokens('c'); // evicts 'b'
    expect(calls).toBe(3);
    counter.countTokens('a'); // still cached
    expect(calls).toBe(3);
    counter.countTokens('b'); // was evicted → re-encoded
    expect(calls).toBe(4);
  });

  it('disables memoization with cacheSize 0', () => {
    let calls = 0;
    const counter = createTiktokenCounter(
      () => { calls++; return [1]; },
      { cacheSize: 0 },
    );
    counter.countTokens('x');
    counter.countTokens('x');
    expect(calls).toBe(2);
  });
});
