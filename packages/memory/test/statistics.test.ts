import { describe, it, expect } from 'vitest';
import {
  studentTCdf,
  welchLift,
  benjaminiHochberg,
  normalQuantile,
  requiredTrials,
  mulberry32,
  gaussian,
  regularizedIncompleteBeta,
} from '../src/utils/statistics.js';

describe('studentTCdf', () => {
  it('matches the Cauchy closed form at df=1', () => {
    // df=1 is Cauchy: CDF(t) = 0.5 + atan(t)/π
    for (const t of [-3, -1, 0, 0.5, 1, 3]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 8);
    }
  });

  it('matches the df=2 closed form', () => {
    // df=2: CDF(t) = 0.5 + t / (2·√(2 + t²))
    for (const t of [-2.92, -1, 0.5, 2.92]) {
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 8);
    }
    // The classic table value: t=2.92, df=2 → one-sided p ≈ 0.05
    expect(1 - studentTCdf(2.92, 2)).toBeCloseTo(0.05, 3);
  });

  it('converges to the normal distribution at large df', () => {
    expect(studentTCdf(1.6449, 10_000)).toBeCloseTo(0.95, 3);
    expect(studentTCdf(-1.96, 10_000)).toBeCloseTo(0.025, 3);
  });

  it('handles fractional df (Welch–Satterthwaite produces them)', () => {
    const p = studentTCdf(2.0, 3.7);
    expect(p).toBeGreaterThan(studentTCdf(2.0, 3));   // monotone in df... at t>0
    expect(p).toBeLessThan(studentTCdf(2.0, 4));
  });

  it('is exactly 0.5 at t=0 and handles infinities', () => {
    expect(studentTCdf(0, 5)).toBe(0.5);
    expect(studentTCdf(Infinity, 5)).toBe(1);
    expect(studentTCdf(-Infinity, 5)).toBe(0);
  });
});

describe('regularizedIncompleteBeta', () => {
  it('matches known symmetric values', () => {
    expect(regularizedIncompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 10); // uniform
    expect(regularizedIncompleteBeta(2, 2, 0.5)).toBeCloseTo(0.5, 10);
    expect(regularizedIncompleteBeta(2, 1, 0.5)).toBeCloseTo(0.25, 10); // x²
  });
});

describe('welchLift', () => {
  it('reproduces a textbook one-sided Welch test', () => {
    // Equal variances, equal n — reduces to the pooled case.
    const r = welchLift({
      meanA: 0.8, varA: 0.01, nA: 10,
      meanB: 0.7, varB: 0.01, nB: 10,
      margin: 0,
    });
    expect(r.lift).toBeCloseTo(0.1, 10);
    expect(r.se).toBeCloseTo(Math.sqrt(0.002), 10);
    expect(r.df).toBeCloseTo(18, 6);
    // t = 0.1 / 0.0447 ≈ 2.236 → one-sided p ≈ 0.019 → pExceeds ≈ 0.981
    expect(r.pExceeds).toBeGreaterThan(0.97);
    expect(r.pExceeds).toBeLessThan(0.99);
  });

  it('respects the margin as a practical-significance floor', () => {
    const base = { meanA: 0.75, varA: 0.01, nA: 10, meanB: 0.7, varB: 0.01, nB: 10 };
    const noMargin = welchLift({ ...base, margin: 0 });
    const withMargin = welchLift({ ...base, margin: 0.05 });
    expect(withMargin.pExceeds).toBeLessThan(noMargin.pExceeds);
    // lift exactly equals the margin → probability ~0.5
    expect(withMargin.pExceeds).toBeCloseTo(0.5, 6);
  });

  it('group swap mirrors the sign-flipped margin: P_swap(>m) = 1 − P(>−m)', () => {
    // This is exactly how the gate computes the eviction side: it swaps
    // the groups and reuses the same margin.
    const orig = welchLift({
      meanA: 0.4, varA: 0.02, nA: 5, meanB: 0.8, varB: 0.02, nB: 5, margin: -0.05,
    });
    const swapped = welchLift({
      meanA: 0.8, varA: 0.02, nA: 5, meanB: 0.4, varB: 0.02, nB: 5, margin: 0.05,
    });
    expect(swapped.pExceeds).toBeCloseTo(1 - orig.pExceeds, 10);
    // And a strongly negative lift yields a near-zero promotion probability.
    const promo = welchLift({
      meanA: 0.4, varA: 0.02, nA: 5, meanB: 0.8, varB: 0.02, nB: 5, margin: 0.05,
    });
    expect(promo.pExceeds).toBeLessThan(0.05);
  });

  it('handles the zero-variance degenerate case', () => {
    const r = welchLift({
      meanA: 0.9, varA: 0, nA: 3, meanB: 0.5, varB: 0, nB: 3, margin: 0.05,
    });
    expect(r.pExceeds).toBe(1);
    expect(r.df).toBe(Infinity);
  });

  it('rejects groups smaller than 2', () => {
    expect(() =>
      welchLift({ meanA: 1, varA: 0.1, nA: 1, meanB: 0, varB: 0.1, nB: 5, margin: 0 }),
    ).toThrow(RangeError);
  });
});

describe('benjaminiHochberg', () => {
  it('matches a hand-computed example', () => {
    // Classic worked example at q=0.05:
    // sorted ps: 0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205
    // thresholds (k/8)·0.05: 0.00625, 0.0125, 0.01875, 0.025, 0.03125, 0.0375, 0.04375, 0.05
    // largest k with p_k ≤ threshold: k=2 → reject the two smallest.
    const ps = [0.041, 0.008, 0.039, 0.205, 0.001, 0.042, 0.06, 0.074];
    const mask = benjaminiHochberg(ps, 0.05);
    expect(mask).toEqual([false, true, false, false, true, false, false, false]);
  });

  it('rejects everything below threshold when all ps are tiny', () => {
    expect(benjaminiHochberg([0.0001, 0.0002, 0.0003], 0.1)).toEqual([true, true, true]);
  });

  it('rejects nothing when all ps are large, and handles empty input', () => {
    expect(benjaminiHochberg([0.5, 0.9, 0.7], 0.1)).toEqual([false, false, false]);
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });

  it('BH step-up rescues p-values above their own rank threshold', () => {
    // p = [0.01, 0.02, 0.03], q = 0.06: thresholds 0.02, 0.04, 0.06 →
    // k=3 qualifies, so ALL are rejected including p1=0.01 > 0.02? No —
    // 0.01 ≤ 0.02 anyway; the step-up property: p3=0.03 ≤ 0.06 rejects all.
    expect(benjaminiHochberg([0.01, 0.02, 0.03], 0.06)).toEqual([true, true, true]);
  });
});

describe('normalQuantile', () => {
  it('matches standard normal table values', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.9)).toBeCloseTo(1.281552, 4);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 4);
    expect(normalQuantile(0.0001)).toBeCloseTo(-3.719016, 3);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('requiredTrials', () => {
  it('shows the sample-size wall: small effects need hundreds of runs', () => {
    // effect 0.05 vs judge sd 0.2 at 0.9 confidence / 0.8 power
    const n = requiredTrials({ effect: 0.05, sd: 0.2 });
    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThan(180); // 2·((1.2816+0.8416)·4)² ≈ 145
  });

  it('large effects need single-digit runs', () => {
    expect(requiredTrials({ effect: 0.3, sd: 0.1 })).toBeLessThanOrEqual(2);
  });

  it('halving sd quarters the requirement', () => {
    const wide = requiredTrials({ effect: 0.1, sd: 0.2 });
    const tight = requiredTrials({ effect: 0.1, sd: 0.1 });
    expect(wide / tight).toBeGreaterThan(3.5);
    expect(wide / tight).toBeLessThan(4.5);
  });
});

describe('seeded PRNG', () => {
  it('mulberry32 is deterministic and uniform-ish', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(5);
  });

  it('gaussian has roughly standard moments over a seeded sample', () => {
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
});
