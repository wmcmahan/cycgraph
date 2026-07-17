/**
 * QA Metrics — SQuAD/HotpotQA-standard Exact Match and token-level F1.
 *
 * Uses the canonical normalization from the SQuAD evaluation script
 * (lowercase, strip punctuation and articles, collapse whitespace) so
 * numbers are directly comparable to published results.
 *
 * @module bench/metrics
 */

/** SQuAD-standard answer normalization. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact match after normalization: 1 or 0. */
export function exactMatch(prediction: string, reference: string): number {
  return normalizeAnswer(prediction) === normalizeAnswer(reference) ? 1 : 0;
}

/** Token-level F1 after normalization (SQuAD-standard). */
export function f1Score(prediction: string, reference: string): number {
  const predTokens = normalizeAnswer(prediction).split(' ').filter(Boolean);
  const refTokens = normalizeAnswer(reference).split(' ').filter(Boolean);

  if (predTokens.length === 0 || refTokens.length === 0) {
    return predTokens.length === refTokens.length ? 1 : 0;
  }

  const refCounts = new Map<string, number>();
  for (const t of refTokens) refCounts.set(t, (refCounts.get(t) ?? 0) + 1);

  let overlap = 0;
  for (const t of predTokens) {
    const remaining = refCounts.get(t) ?? 0;
    if (remaining > 0) {
      overlap++;
      refCounts.set(t, remaining - 1);
    }
  }

  if (overlap === 0) return 0;
  const precision = overlap / predTokens.length;
  const recall = overlap / refTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Exact match against multiple gold surface forms: max over golds.
 * This is the official protocol for datasets with answer aliases
 * (MuSiQue, TriviaQA) — a prediction matching any gold scores full
 * credit. With a single gold this is identical to `exactMatch`.
 */
export function bestExactMatch(prediction: string, golds: string[]): number {
  return Math.max(0, ...golds.map(g => exactMatch(prediction, g)));
}

/** Token-level F1 against multiple gold surface forms: max over golds. */
export function bestF1(prediction: string, golds: string[]): number {
  return Math.max(0, ...golds.map(g => f1Score(prediction, g)));
}

/** Mean of a numeric array (0 for empty). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 95% confidence interval half-width for the mean of paired deltas
 * (normal approximation; sample stddev with n-1).
 */
export function ci95(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1);
  return 1.96 * Math.sqrt(variance / n);
}
