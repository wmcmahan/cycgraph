/**
 * Pure statistical primitives backing the retention gate's inference rule
 * and the gate simulator (utils/statistics). Every function is
 * deterministic, so assertions pin exact values or tight known-good
 * approximations against closed forms and standard reference tables.
 */

import { describe, it, expect } from 'vitest';
import {
  logGamma,
  regularizedIncompleteBeta,
  studentTCdf,
  welchLift,
  benjaminiHochberg,
  normalQuantile,
  requiredTrials,
  mulberry32,
  gaussian,
} from '../src/utils/statistics.js';

describe('logGamma', () => {
  it('is zero at the factorial fixed points gamma(1) and gamma(2)', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
  });

  it('matches ln((n-1)!) at integer arguments', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(6)).toBeCloseTo(Math.log(120), 12);
  });

  it('matches gamma(1/2) = sqrt(pi)', () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });
});

describe('regularizedIncompleteBeta', () => {
  it('reduces to the identity for the uniform case I_x(1,1) = x', () => {
    expect(regularizedIncompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(regularizedIncompleteBeta(1, 1, 0.87)).toBeCloseTo(0.87, 10);
  });

  it('matches known symmetric and power-law values', () => {
    expect(regularizedIncompleteBeta(2, 2, 0.5)).toBeCloseTo(0.5, 10);
    expect(regularizedIncompleteBeta(2, 1, 0.5)).toBeCloseTo(0.25, 10);
  });

  it('evaluates the upper continued-fraction branch (x past the switch point)', () => {
    expect(regularizedIncompleteBeta(2, 1, 0.9)).toBeCloseTo(0.81, 10);
  });

  it('clamps to 0 at or below x = 0', () => {
    expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
    expect(regularizedIncompleteBeta(2, 3, -0.5)).toBe(0);
  });

  it('clamps to 1 at or above x = 1', () => {
    expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
    expect(regularizedIncompleteBeta(2, 3, 1.5)).toBe(1);
  });
});

describe('studentTCdf', () => {
  it('matches the Cauchy closed form at df = 1', () => {
    for (const t of [-3, -1, 0, 0.5, 1, 3]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 8);
    }
  });

  it('matches the df = 2 closed form', () => {
    for (const t of [-2.92, -1, 0.5, 2.92]) {
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 8);
    }
  });

  it('reproduces the classic t-table upper tail (t=2.92, df=2 -> p≈0.05)', () => {
    expect(1 - studentTCdf(2.92, 2)).toBeCloseTo(0.05, 3);
  });

  it('converges to the normal distribution at large df', () => {
    expect(studentTCdf(1.6449, 10_000)).toBeCloseTo(0.95, 3);
    expect(studentTCdf(-1.96, 10_000)).toBeCloseTo(0.025, 3);
  });

  it('increases in df at a fixed positive t (thinner tails)', () => {
    const fractional = studentTCdf(2.0, 3.7);

    expect(fractional).toBeGreaterThan(studentTCdf(2.0, 3));
    expect(fractional).toBeLessThan(studentTCdf(2.0, 4));
  });

  it('is exactly 0.5 at t = 0 and saturates at infinities', () => {
    expect(studentTCdf(0, 5)).toBe(0.5);
    expect(studentTCdf(Infinity, 5)).toBe(1);
    expect(studentTCdf(-Infinity, 5)).toBe(0);
  });

  it('rejects non-positive degrees of freedom', () => {
    expect(() => studentTCdf(1, 0)).toThrow(RangeError);
    expect(() => studentTCdf(1, -2)).toThrow(RangeError);
  });
});

describe('welchLift', () => {
  it('reproduces a textbook one-sided Welch test', () => {
    const r = welchLift({
      meanA: 0.8, varA: 0.01, nA: 10,
      meanB: 0.7, varB: 0.01, nB: 10,
      margin: 0,
    });

    expect(r.lift).toBeCloseTo(0.1, 10);
    expect(r.se).toBeCloseTo(Math.sqrt(0.002), 10);
    expect(r.df).toBeCloseTo(18, 6);
    expect(r.pExceeds).toBeGreaterThan(0.97);
    expect(r.pExceeds).toBeLessThan(0.99);
  });

  it('treats the margin as a practical-significance floor', () => {
    const base = { meanA: 0.75, varA: 0.01, nA: 10, meanB: 0.7, varB: 0.01, nB: 10 };

    const noMargin = welchLift({ ...base, margin: 0 });
    const withMargin = welchLift({ ...base, margin: 0.05 });

    expect(withMargin.pExceeds).toBeLessThan(noMargin.pExceeds);
    expect(withMargin.pExceeds).toBeCloseTo(0.5, 6);
  });

  it('mirrors a group swap against the sign-flipped margin: P_swap(>m) = 1 − P(>−m)', () => {
    const orig = welchLift({
      meanA: 0.4, varA: 0.02, nA: 5, meanB: 0.8, varB: 0.02, nB: 5, margin: -0.05,
    });
    const swapped = welchLift({
      meanA: 0.8, varA: 0.02, nA: 5, meanB: 0.4, varB: 0.02, nB: 5, margin: 0.05,
    });

    expect(swapped.pExceeds).toBeCloseTo(1 - orig.pExceeds, 10);
  });

  it('gives a near-zero promotion probability for a strongly negative lift', () => {
    const promo = welchLift({
      meanA: 0.4, varA: 0.02, nA: 5, meanB: 0.8, varB: 0.02, nB: 5, margin: 0.05,
    });

    expect(promo.pExceeds).toBeLessThan(0.05);
  });

  it('returns a certain verdict when both variances are zero and the lift clears the margin', () => {
    const r = welchLift({
      meanA: 0.9, varA: 0, nA: 3, meanB: 0.5, varB: 0, nB: 3, margin: 0.05,
    });

    expect(r.pExceeds).toBe(1);
    expect(r.se).toBe(0);
    expect(r.df).toBe(Infinity);
  });

  it('returns probability 0 when both variances are zero and the lift misses the margin', () => {
    const r = welchLift({
      meanA: 0.5, varA: 0, nA: 3, meanB: 0.5, varB: 0, nB: 3, margin: 0.05,
    });

    expect(r.pExceeds).toBe(0);
    expect(r.se).toBe(0);
    expect(r.df).toBe(Infinity);
  });

  it('rejects groups smaller than 2', () => {
    expect(() =>
      welchLift({ meanA: 1, varA: 0.1, nA: 1, meanB: 0, varB: 0.1, nB: 5, margin: 0 }),
    ).toThrow(RangeError);
  });

  it('rejects negative variances', () => {
    expect(() =>
      welchLift({ meanA: 1, varA: -0.1, nA: 3, meanB: 0, varB: 0.1, nB: 3, margin: 0 }),
    ).toThrow(RangeError);
  });
});

describe('benjaminiHochberg', () => {
  it('matches a hand-computed example at q = 0.05', () => {
    const ps = [0.041, 0.008, 0.039, 0.205, 0.001, 0.042, 0.06, 0.074];

    const mask = benjaminiHochberg(ps, 0.05);

    expect(mask).toEqual([false, true, false, false, true, false, false, false]);
  });

  it('rejects everything when all p-values are tiny', () => {
    expect(benjaminiHochberg([0.0001, 0.0002, 0.0003], 0.1)).toEqual([true, true, true]);
  });

  it('rejects nothing when all p-values are large', () => {
    expect(benjaminiHochberg([0.5, 0.9, 0.7], 0.1)).toEqual([false, false, false]);
  });

  it('returns an empty mask for empty input', () => {
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });

  it('step-up rescues smaller p-values once the largest rank qualifies', () => {
    expect(benjaminiHochberg([0.01, 0.02, 0.03], 0.06)).toEqual([true, true, true]);
  });
});

describe('normalQuantile', () => {
  it('is 0 at the median', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
  });

  it('matches standard normal table values in the central region', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.9)).toBeCloseTo(1.281552, 4);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 4);
  });

  it('matches the lower tail below the Acklam switch point', () => {
    expect(normalQuantile(0.0001)).toBeCloseTo(-3.719016, 4);
  });

  it('matches the upper tail above the Acklam switch point', () => {
    expect(normalQuantile(0.9999)).toBeCloseTo(3.719016, 4);
  });

  it('is antisymmetric about the median', () => {
    expect(normalQuantile(0.8)).toBeCloseTo(-normalQuantile(0.2), 8);
  });

  it('rejects inputs outside the open interval (0, 1)', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('requiredTrials', () => {
  it('shows the sample-size wall: small effects need over a hundred runs', () => {
    const n = requiredTrials({ effect: 0.05, sd: 0.2 });

    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThan(180);
  });

  it('needs single-digit runs for large effects', () => {
    expect(requiredTrials({ effect: 0.3, sd: 0.1 })).toBeLessThanOrEqual(2);
  });

  it('quarters the requirement when the sd is halved', () => {
    const wide = requiredTrials({ effect: 0.1, sd: 0.2 });
    const tight = requiredTrials({ effect: 0.1, sd: 0.1 });

    expect(wide / tight).toBeGreaterThan(3.5);
    expect(wide / tight).toBeLessThan(4.5);
  });

  it('honours custom confidence and power', () => {
    const lenient = requiredTrials({ effect: 0.1, sd: 0.2, confidence: 0.8, power: 0.7 });
    const strict = requiredTrials({ effect: 0.1, sd: 0.2, confidence: 0.95, power: 0.9 });

    expect(strict).toBeGreaterThan(lenient);
  });

  it('rejects a non-positive effect', () => {
    expect(() => requiredTrials({ effect: 0, sd: 0.1 })).toThrow(RangeError);
    expect(() => requiredTrials({ effect: -0.1, sd: 0.1 })).toThrow(RangeError);
  });

  it('rejects a non-positive sd', () => {
    expect(() => requiredTrials({ effect: 0.1, sd: 0 })).toThrow(RangeError);
    expect(() => requiredTrials({ effect: 0.1, sd: -0.2 })).toThrow(RangeError);
  });
});

describe('mulberry32', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);

    expect(Array.from({ length: 5 }, () => a())).toEqual(Array.from({ length: 5 }, () => b()));
  });

  it('produces distinct sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);

    expect(a()).not.toBe(b());
  });

  it('stays within [0, 1)', () => {
    const rng = mulberry32(99);

    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('gaussian', () => {
  it('has roughly standard moments over a seeded sample', () => {
    const rng = mulberry32(7);
    const n = 20_000;
    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < n; i++) {
      const g = gaussian(rng);
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;

    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(variance).toBeGreaterThan(0.94);
    expect(variance).toBeLessThan(1.06);
  });

  it('is deterministic given a seeded source', () => {
    const first = gaussian(mulberry32(3));
    const second = gaussian(mulberry32(3));

    expect(first).toBe(second);
  });
});
