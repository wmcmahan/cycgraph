/**
 * Outlier detection
 *
 * Runs that took far longer to execute than comparable runs of the same
 * workflow. Nothing has gone wrong in a way the engine would name, which is
 * exactly why it needs measuring.
 *
 * **Execution time, not wall clock.** A run pauses for approvals and waits on
 * remote agents, and none of that is work the workflow did or a change could
 * affect. One recorded approval run shows 31 seconds of wall clock against 4
 * milliseconds of node execution, and its whole workflow averages 4 seconds of
 * wall clock against 6 milliseconds of work. Summing node time makes the two
 * kinds of run comparable without anything having to know which is which.
 *
 * **Comparability is the whole problem.** An outlier is a claim that one
 * measurement is unlike others, which is only meaningful once the others are
 * genuinely alike. A run given different parameters, or made against a
 * different model, is not the same run, so runs are bucketed by both before
 * any median is taken.
 *
 * There is deliberately no token detector. Per-call token cost across this
 * corpus varies by a few percent, so every statistical test finds a
 * significant difference of no practical size. Where the tokens go is a
 * question about proportion rather than about defect, and `profile.ts`
 * answers it.
 *
 * @module insights/outliers
 */

import type { Detector, Finding, RunTelemetry } from './types.js';
import { seenAt, startTimes } from './recency.js';

/** How many run ids a finding carries. */
const SAMPLE_LIMIT = 5;

/** Comparable runs needed before a median describes anything. */
const MIN_RUNS = 5;

/** Robust deviations from the median before a run is slow. */
const THRESHOLD = 3.5;

/** Scale factor making MAD comparable to a standard deviation on normal data. */
const MAD_TO_SIGMA = 1.4826;

/** Times the median a run must take, on top of the deviation test. */
const SLOW_MULTIPLE = 2;

/**
 * Milliseconds a run must exceed the median by.
 *
 * The deviation test alone flags 150ms against a 70ms median, because a
 * sub-second median has a MAD of a few milliseconds and everything is far from
 * it in those units. Nobody is going to act on 80ms.
 */
const SLOW_MARGIN_MS = 2000;

/** Middle value of a copy, leaving the caller's array alone. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Robust z-score: how many scaled median-absolute-deviations from the median.
 *
 * Returns 0 when the MAD is zero — more than half the observations are
 * identical, so there is no spread to be an outlier against and any difference
 * would divide to infinity.
 */
function robustZ(value: number, values: readonly number[]): number {
  const mid = median(values);
  const mad = median(values.map(v => Math.abs(v - mid)));
  if (mad === 0) return 0;
  return Math.abs(value - mid) / (mad * MAD_TO_SIGMA);
}

/** Group by a derived key, preserving encounter order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k) ?? [];
    group.push(item);
    groups.set(k, group);
  }
  return groups;
}

/**
 * Time a run spent executing nodes.
 *
 * Undefined rather than zero when nothing was attributed, so a run whose
 * timing was never recorded is skipped instead of counting as instantaneous
 * and dragging every median toward zero.
 */
export function computeMs(run: RunTelemetry): number | undefined {
  const entries = Object.values(run.nodeTiming ?? {});
  if (entries.length === 0) return undefined;
  return entries.reduce((sum, entry) => sum + entry.total_ms, 0);
}

/** The parameters that differ across a set of runs, sorted. */
function varyingParams(group: readonly RunTelemetry[]): string[] {
  const seen = new Map<string, Set<string>>();

  for (const run of group) {
    for (const [key, value] of Object.entries(run.params ?? {})) {
      const values = seen.get(key) ?? new Set<string>();
      values.add(JSON.stringify(value) ?? String(value));
      seen.set(key, values);
    }
  }

  return [...seen].filter(([, values]) => values.size > 1).map(([key]) => key).sort();
}

/**
 * What makes two runs of one workflow comparable.
 *
 * Only the parameters that actually vary, because a parameter every run agrees
 * on cannot distinguish them and including it would just make the label
 * unreadable.
 */
function comparabilityKey(run: RunTelemetry, varying: readonly string[]): string {
  const params = varying.map(key => `${key}=${JSON.stringify(run.params?.[key])}`);
  return [run.model ?? 'unknown-model', ...params].join(' ');
}

/** A run and the execution time it was measured at. */
interface TimedRun {
  run: RunTelemetry;
  ms: number;
}

/**
 * Runs that executed for far longer than comparable runs of the same workflow.
 *
 * Three conditions, because each alone is wrong. The deviation test finds the
 * shape, the multiple keeps it proportional, and the absolute margin stops a
 * workflow that normally finishes in seventy milliseconds from reporting every
 * run that took a hundred and fifty.
 *
 * Bucketing by model and varying parameters costs coverage: a workflow whose
 * runs spread thinly across many buckets reports nothing, because no bucket
 * reaches the minimum. That is the honest outcome. A median over a mixture of
 * two populations describes neither of them.
 */
function durationFindings(
  workflow: string,
  group: readonly RunTelemetry[],
  times: ReadonlyMap<string, string>,
): Finding[] {
  const timed: TimedRun[] = [];
  for (const run of group) {
    const ms = computeMs(run);
    if (ms !== undefined && ms > 0) timed.push({ run, ms });
  }

  const varying = varyingParams(timed.map(t => t.run));
  const findings: Finding[] = [];

  for (const [key, bucket] of groupBy(timed, t => comparabilityKey(t.run, varying))) {
    if (bucket.length < MIN_RUNS) continue;

    const durations = bucket.map(t => t.ms);
    const typical = median(durations);

    const slow = bucket.filter(t =>
      t.ms >= typical * SLOW_MULTIPLE
      && t.ms - typical >= SLOW_MARGIN_MS
      && robustZ(t.ms, durations) >= THRESHOLD);

    if (slow.length === 0) continue;

    const slowest = Math.max(...slow.map(t => t.ms));
    const runIds = slow.map(t => t.run.runId);
    findings.push({
      id: `outlier:duration:${workflow}:${key}`,
      detector: 'outliers',
      severity: 'low',
      workflow,
      title: `${workflow} sometimes executes for far longer than usual`,
      detail: [
        `${slow.length} of ${bucket.length} comparable runs, up to ${Math.round(slowest)}ms of node time against a median of ${Math.round(typical)}ms`,
        ...(varying.length > 0 ? [`comparable meaning ${key}`] : []),
      ].join(' — '),
      evidence: {
        runs: slow.length,
        occurrences: slow.length,
        sampleRunIds: runIds.slice(0, SAMPLE_LIMIT),
        of: bucket.length,
        ...seenAt(runIds, times),
      },
      addresses: 'runs given the same inputs spend very different amounts of time executing, so something is retrying, looping, or generating far more in only some of them',
    });
  }

  return findings;
}

/**
 * Report runs that executed for far longer than comparable runs of the same
 * workflow.
 *
 * Compared within a workflow, never across: a supervisor loop and a two-node
 * pipeline have no shared scale.
 */
export const detectOutliers: Detector = (runs: readonly RunTelemetry[]): Finding[] => {
  const times = startTimes(runs);

  return [...groupBy(runs, run => run.workflow)]
    .flatMap(([workflow, group]) => durationFindings(workflow, group, times));
};
