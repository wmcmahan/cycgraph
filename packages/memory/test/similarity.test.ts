/**
 * Tests for utils/similarity: cosine similarity with guard rails for
 * mismatched, empty, and zero-magnitude vectors.
 */

import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/index.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical direction vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBe(1);
  });

  it('returns 0 when dimensionalities differ', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for two empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when one vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});
