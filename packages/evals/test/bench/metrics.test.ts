import { describe, it, expect } from 'vitest';
import { normalizeAnswer, exactMatch, f1Score, mean, ci95 } from '../../src/bench/metrics.js';

describe('normalizeAnswer (SQuAD-standard)', () => {
  it('lowercases, strips punctuation and articles, collapses whitespace', () => {
    expect(normalizeAnswer('The  Quick, Brown-Fox!')).toBe('quick brown fox');
    expect(normalizeAnswer('a Denver')).toBe('denver');
    // SQuAD normalization strips ALL punctuation, including '$'
    expect(normalizeAnswer('$42,000')).toBe('42 000');
  });
});

describe('exactMatch', () => {
  it('matches after normalization', () => {
    expect(exactMatch('The Denver', 'denver')).toBe(1);
    expect(exactMatch('Denver, Colorado', 'Denver')).toBe(0);
  });
});

describe('f1Score', () => {
  it('is 1 for identical answers', () => {
    expect(f1Score('Barack Obama', 'barack obama')).toBe(1);
  });

  it('computes token-level partial overlap', () => {
    // prediction {denver, colorado}, reference {denver}:
    // precision 1/2, recall 1/1 -> F1 = 2/3
    expect(f1Score('Denver Colorado', 'Denver')).toBeCloseTo(2 / 3, 5);
  });

  it('is 0 for disjoint answers', () => {
    expect(f1Score('Austin', 'Denver')).toBe(0);
  });

  it('handles empty predictions', () => {
    expect(f1Score('', 'Denver')).toBe(0);
    expect(f1Score('', '')).toBe(1);
  });

  it('respects reference token multiplicity', () => {
    // reference has one 'very'; prediction spamming it gains no extra overlap
    expect(f1Score('very very very', 'very good')).toBeCloseTo(
      (2 * (1 / 3) * (1 / 2)) / (1 / 3 + 1 / 2),
      5,
    );
  });
});

describe('stats helpers', () => {
  it('mean of empty is 0', () => {
    expect(mean([])).toBe(0);
  });

  it('ci95 is 0 for fewer than 2 samples and grows with variance', () => {
    expect(ci95([0.5])).toBe(0);
    const tight = ci95([0.5, 0.5, 0.5, 0.5]);
    const loose = ci95([0.0, 1.0, 0.0, 1.0]);
    expect(tight).toBe(0);
    expect(loose).toBeGreaterThan(0.4);
  });
});
