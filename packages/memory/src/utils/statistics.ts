/**
 * Statistics Utilities
 *
 * Pure, dependency-free statistical primitives backing the eval-gating
 * retention gate's inference decision rule and the gate validation
 * simulator. Everything here is deterministic: the only randomness is
 * the explicitly-seeded `mulberry32` PRNG used by the simulator.
 *
 * Numerical methods are the standard ones (Lanczos log-gamma, Lentz
 * continued-fraction incomplete beta, Acklam inverse-normal) — each is
 * pinned to known reference values in `test/statistics.test.ts`.
 *
 * @module utils/statistics
 */

// ─── Log-gamma (Lanczos approximation) ──────────────────────────────

const LANCZOS_G = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];

/** Natural log of the gamma function, for x > 0. */
export function logGamma(x: number): number {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coeff of LANCZOS_G) {
    y += 1;
    ser += coeff / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// ─── Regularized incomplete beta I_x(a, b) ──────────────────────────

const MAX_ITERATIONS = 200;
const EPSILON = 3e-12;
const FPMIN = 1e-300;

/** Continued-fraction evaluation for the incomplete beta (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), for 0 ≤ x ≤ 1. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(logBt);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

// ─── Student's t distribution ───────────────────────────────────────

/**
 * CDF of Student's t distribution with `df` degrees of freedom:
 * P(T ≤ t). df may be fractional (Welch–Satterthwaite produces
 * non-integer df).
 */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (df <= 0) throw new RangeError(`studentTCdf: df must be > 0, got ${df}`);
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

// ─── Welch lift inference ───────────────────────────────────────────

export interface WelchLiftInput {
  /** Group A (e.g. runs WITH the lesson): mean, sample variance, count. */
  meanA: number;
  varA: number;
  nA: number;
  /** Group B (e.g. baseline runs WITHOUT the lesson). */
  meanB: number;
  varB: number;
  nB: number;
  /** The lift threshold being tested (practical-significance floor). */
  margin: number;
}

export interface WelchLiftResult {
  /** Point estimate of the lift: meanA − meanB. */
  lift: number;
  /** Welch standard error of the lift. */
  se: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  /**
   * P(true lift > margin) under the t-approximate posterior with a flat
   * prior — numerically a one-sided Welch test. Test against −margin to
   * get the eviction-side probability.
   */
  pExceeds: number;
}

/**
 * Welch-style inference on the difference of two group means.
 *
 * Requires nA ≥ 2 and nB ≥ 2 (variance needs at least one degree of
 * freedom per group). Callers should floor tiny-sample variances to a
 * noise floor before calling — see `RetentionPolicy.noiseFloorSd`.
 */
export function welchLift(input: WelchLiftInput): WelchLiftResult {
  const { meanA, varA, nA, meanB, varB, nB, margin } = input;
  if (nA < 2 || nB < 2) {
    throw new RangeError(`welchLift: both groups need n ≥ 2 (got ${nA}, ${nB})`);
  }
  if (varA < 0 || varB < 0) {
    throw new RangeError('welchLift: variances must be non-negative');
  }

  const lift = meanA - meanB;
  const sa = varA / nA;
  const sb = varB / nB;
  const se = Math.sqrt(sa + sb);

  // Degenerate zero-variance case: the lift is known exactly.
  if (se === 0) {
    return { lift, se, df: Infinity, pExceeds: lift > margin ? 1 : 0 };
  }

  const df = (sa + sb) ** 2 / (sa ** 2 / (nA - 1) + sb ** 2 / (nB - 1));
  // Posterior: lift_true ~ lift + se · T_df  ⇒  P(lift_true > margin)
  const pExceeds = 1 - studentTCdf((margin - lift) / se, df);
  return { lift, se, df, pExceeds };
}

// ─── Benjamini–Hochberg ─────────────────────────────────────────────

/**
 * Benjamini–Hochberg false-discovery-rate control. Given p-values and a
 * target FDR `q`, returns a boolean mask: `true` = rejection survives.
 * Deterministic ties: stable sort on (p, index).
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  const k = pValues.length;
  if (k === 0) return [];
  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p !== b.p ? a.p - b.p : a.i - b.i));

  let maxRank = 0;
  for (let rank = 1; rank <= k; rank++) {
    if (order[rank - 1].p <= (rank / k) * q) maxRank = rank;
  }

  const reject = new Array<boolean>(k).fill(false);
  for (let rank = 1; rank <= maxRank; rank++) {
    reject[order[rank - 1].i] = true;
  }
  return reject;
}

// ─── Inverse normal CDF (Acklam's approximation) ────────────────────

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];

/** Inverse of the standard normal CDF (quantile function), 0 < p < 1. */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  }
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const qv = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACKLAM_C[0] * qv + ACKLAM_C[1]) * qv + ACKLAM_C[2]) * qv + ACKLAM_C[3]) * qv + ACKLAM_C[4]) * qv + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * qv + ACKLAM_D[1]) * qv + ACKLAM_D[2]) * qv + ACKLAM_D[3]) * qv + 1);
  } else if (p <= 1 - pLow) {
    const qv = p - 0.5;
    const r = qv * qv;
    x =
      ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * qv) /
      (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
  } else {
    const qv = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((ACKLAM_C[0] * qv + ACKLAM_C[1]) * qv + ACKLAM_C[2]) * qv + ACKLAM_C[3]) * qv + ACKLAM_C[4]) * qv + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * qv + ACKLAM_D[1]) * qv + ACKLAM_D[2]) * qv + ACKLAM_D[3]) * qv + 1);
  }
  return x;
}

// ─── Power calculation ──────────────────────────────────────────────

export interface RequiredTrialsInput {
  /** Smallest lift you want the gate to detect (e.g. 0.05). */
  effect: number;
  /** Run-score standard deviation — judge noise plus run variability. */
  sd: number;
  /** Decision confidence, as in RetentionPolicy (default 0.9). */
  confidence?: number;
  /** Desired detection power (default 0.8). */
  power?: number;
}

/**
 * Approximate per-group runs needed for the gate to detect `effect`
 * with the given confidence and power: `2·((z_α + z_β)·sd / effect)²`.
 *
 * This is the sample-size wall in one line: halving the judge SD
 * (e.g. by adding judge samples) cuts the required runs by 4×;
 * halving the effect size multiplies them by 4×.
 */
export function requiredTrials(input: RequiredTrialsInput): number {
  const { effect, sd } = input;
  const confidence = input.confidence ?? 0.9;
  const power = input.power ?? 0.8;
  if (effect <= 0) throw new RangeError('requiredTrials: effect must be > 0');
  if (sd <= 0) throw new RangeError('requiredTrials: sd must be > 0');
  const za = normalQuantile(confidence);
  const zb = normalQuantile(power);
  return Math.ceil(2 * ((za + zb) * sd / effect) ** 2);
}

// ─── Seeded PRNG (simulator) ────────────────────────────────────────

/** Deterministic uniform PRNG in [0, 1) — mulberry32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample from a uniform PRNG (Box–Muller). */
export function gaussian(rng: () => number): number {
  let u = 0;
  // Avoid log(0).
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
