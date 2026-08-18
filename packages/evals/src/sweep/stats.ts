/**
 * Small-sample rate comparison
 *
 * Fisher's exact test, one-sided, for "does this arm pass more often than
 * that one". Exact rather than approximate because sweep samples are tiny —
 * five draws per arm is the working size — and every normal-approximation
 * test is dishonest there. Exact also means deterministic: the same counts
 * always produce the same p-value, so the decision rule stays replayable.
 *
 * Deliberately not the eval-gate's Welch machinery. That gate compares
 * continuous judge scores across many runs; this compares binary pass/fail
 * across a handful of forks, and a t-test on five zeros and ones answers a
 * question about means that nobody asked.
 *
 * @module sweep/stats
 */

/** log(n!), exact for the sizes a sweep produces. */
function logFactorial(n: number): number {
  let total = 0;
  for (let i = 2; i <= n; i++) total += Math.log(i);
  return total;
}

/** log of the binomial coefficient C(n, k). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-sided Fisher's exact test: the probability, under no real difference,
 * of the first arm passing at least as often as observed.
 *
 * Small is evidence the first arm genuinely passes more often. The tails the
 * test sums are hypergeometric: condition on the total number of passes and
 * ask how surprising this split of them is.
 */
export function fisherExactOneSided(
  passedA: number,
  totalA: number,
  passedB: number,
  totalB: number,
): number {
  const passes = passedA + passedB;
  const n = totalA + totalB;
  if (totalA === 0 || totalB === 0) return 1;

  const logDenominator = logChoose(n, passes);
  let p = 0;
  for (let k = passedA; k <= Math.min(totalA, passes); k++) {
    p += Math.exp(logChoose(totalA, k) + logChoose(totalB, passes - k) - logDenominator);
  }
  // Summation error can nudge past 1 when the observed split is the likeliest.
  return Math.min(1, p);
}
