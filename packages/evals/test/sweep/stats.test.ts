/**
 * Tests for fisherExactOneSided (src/sweep/stats.ts).
 */

import { describe, it, expect } from 'vitest';
import { fisherExactOneSided } from '../../src/sweep/stats.js';

describe('fisherExactOneSided', () => {
  it('computes the textbook value for a perfect arm against a failing one', () => {
    expect(fisherExactOneSided(5, 5, 2, 5)).toBeCloseTo(1 / 12, 10);
  });

  it('computes the tail sum, not just the observed table', () => {
    expect(fisherExactOneSided(4, 5, 1, 5)).toBeCloseTo(26 / 252, 10);
  });

  it('finds a perfect arm against a near-total failure significant', () => {
    expect(fisherExactOneSided(5, 5, 0, 5)).toBeCloseTo(1 / 252, 10);
  });

  it('stays far from significance when the arms are identical', () => {
    expect(fisherExactOneSided(3, 5, 3, 5)).toBeCloseTo(155 / 210, 10);
  });

  it('returns one when the first arm is worse', () => {
    const p = fisherExactOneSided(1, 5, 4, 5);

    expect(p).toBeGreaterThan(0.98);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('never exceeds one', () => {
    expect(fisherExactOneSided(0, 5, 0, 5)).toBe(1);
  });

  it('returns one for an empty arm', () => {
    expect(fisherExactOneSided(0, 0, 3, 5)).toBe(1);
    expect(fisherExactOneSided(3, 5, 0, 0)).toBe(1);
  });

  it('handles asymmetric arm sizes', () => {
    const p = fisherExactOneSided(10, 10, 20, 40);

    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.05);
  });

  it('is deterministic', () => {
    expect(fisherExactOneSided(4, 5, 2, 5)).toBe(fisherExactOneSided(4, 5, 2, 5));
  });
});
