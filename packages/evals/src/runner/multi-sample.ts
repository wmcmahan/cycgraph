/**
 * Multi-Sample Semantic Evaluation
 *
 * Wraps `evaluateMetric` to run N independent samples against the judge,
 * then reports the median score along with cross-sample stability. Used
 * by the runner to distinguish two kinds of semantic failure:
 *
 *   - **drift failure** — the model + judge produced a stable but
 *     too-low median. The thing under test genuinely regressed.
 *   - **flaky failure** — samples diverged wildly. The judge or model
 *     is non-deterministic enough that the gate's signal is unreliable.
 *
 * Conflating these two has historically caused either false confidence
 * (single-sample passing happens to be lucky) or false alarms (single
 * unlucky sample tanks the build). Multi-sample evaluation gives each
 * failure mode a distinct exit category.
 *
 * @module runner/multi-sample
 */

import { evaluateMetric } from '../assertions/semantic-judge.js';
import type {
  RubricMetric,
  SemanticJudgeContext,
} from '../assertions/semantic-judge.js';

/** Aggregate result across N samples of one metric on one test case. */
export interface MultiSampleResult {
  /** Metric name (e.g., "answer_relevancy"). */
  metric: string;
  /** Median score across all samples. Used as the comparison anchor. */
  median: number;
  /** Standard deviation across samples — variance proxy. */
  stdDev: number;
  /** Raw scores in invocation order, for debugging. */
  samples: number[];
  /** Whether the samples are tightly clustered (`stdDev < stabilityCeiling`). */
  stable: boolean;
  /**
   * True iff `median >= threshold` AND `stable`. Distinguishes from
   * `flaky` (high stdDev) and `regressed` (low median, stable).
   */
  passed: boolean;
  /**
   * Reasoning from the sample whose score is closest to the median — the
   * most representative of the run. Useful when the metric passes; less
   * useful when failures are heterogeneous, but better than nothing.
   */
  reasoning: string;
}

/** Options for multi-sample evaluation. */
export interface MultiSampleOptions {
  /** Number of independent samples to collect (default: 3). */
  samples?: number;
  /** Minimum median for a passing result (default: 0.8). */
  threshold?: number;
  /**
   * stdDev ceiling above which samples are considered too variable for
   * the median to be trusted (default: 0.1).
   */
  stabilityCeiling?: number;
}

const DEFAULT_OPTIONS: Required<MultiSampleOptions> = {
  samples: 3,
  threshold: 0.8,
  stabilityCeiling: 0.1,
};

/**
 * Run the same metric N times against the judge and aggregate the scores.
 *
 * Samples are collected sequentially — the judge is typically a remote
 * LLM call so parallelism here would mostly increase rate-limit pressure
 * without helping latency much for a 3-sample default. If you need true
 * parallelism, fan out at the test-case level instead.
 *
 * @param context - The judge context (input + actual + expected output).
 * @param metric - The rubric metric to evaluate.
 * @param callJudge - Function that sends a prompt to the judge and returns
 *                    the raw response.
 * @param options - Sample count, threshold, stability ceiling overrides.
 */
export async function evaluateMetricMultiSample(
  context: SemanticJudgeContext,
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  options: MultiSampleOptions = {},
): Promise<MultiSampleResult> {
  // Spread-merge cannot use the raw options object — explicit `undefined`
  // entries (common when callers thread optional fields through) would
  // override the defaults and produce silent NaN comparisons.
  const cfg: Required<MultiSampleOptions> = {
    samples: options.samples ?? DEFAULT_OPTIONS.samples,
    threshold: options.threshold ?? DEFAULT_OPTIONS.threshold,
    stabilityCeiling: options.stabilityCeiling ?? DEFAULT_OPTIONS.stabilityCeiling,
  };

  const results = [];
  for (let i = 0; i < cfg.samples; i++) {
    results.push(await evaluateMetric(context, metric, callJudge, cfg.threshold));
  }

  const scores = results.map(r => r.score);
  const median = computeMedian(scores);
  const stdDev = computeStdDev(scores);
  const stable = stdDev < cfg.stabilityCeiling;
  const passed = stable && median >= cfg.threshold;

  // Pick the reasoning from the sample whose score is closest to the
  // median — that's the most "representative" of the run.
  const reasoning = pickRepresentativeReasoning(results, median);

  return {
    metric: metric.name,
    median,
    stdDev,
    samples: scores,
    stable,
    passed,
    reasoning,
  };
}

// ─── Stats Helpers ─────────────────────────────────────────────────

/** Median of a numeric array. Returns 0 for empty input. */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Population standard deviation. Returns 0 for empty or single-element input. */
export function computeStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function pickRepresentativeReasoning(
  results: Array<{ score: number; reasoning: string }>,
  target: number,
): string {
  if (results.length === 0) return '';
  let best = results[0];
  let bestDelta = Math.abs(best.score - target);
  for (const r of results) {
    const delta = Math.abs(r.score - target);
    if (delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }
  return best.reasoning;
}
