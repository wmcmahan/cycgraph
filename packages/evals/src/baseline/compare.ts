/**
 * Baseline Comparison
 *
 * Computes the delta between a current run's snapshot and the prior
 * baseline. Designed to surface regressions that the absolute drift
 * ceiling would otherwise miss — e.g., a suite going from 0% drift to
 * 4% drift (still below a 5% ceiling) is a meaningful regression worth
 * flagging.
 *
 * The default noise floor (1 percentage point) absorbs sample-to-sample LLM
 * jitter while staying well BELOW the absolute drift ceiling (~5%). A noise
 * floor equal to the ceiling was a blind spot: a suite drifting 0% → 4.9% was
 * neither a regression (< floor) nor a ceiling failure (< ceiling), so
 * sub-ceiling regressions were invisible.
 *
 * @module baseline/compare
 */

import type {
  BaselineSnapshot,
  BaselineDelta,
  SuiteDelta,
} from './types.js';

export interface CompareBaselineOptions {
  /**
   * Minimum absolute percent change to count as a regression/improvement.
   * Smaller deltas are noise and ignored. Defaults to 1 percentage point —
   * kept well below the drift ceiling so sub-ceiling regressions are caught.
   */
  noiseFloor?: number;
}

/**
 * Compare a current snapshot against a prior baseline.
 *
 * - If `baseline` is null (first run ever), returns a delta with
 *   `hasBaseline: false` and no regressions.
 * - A suite is a "regression" iff `after - before >= noiseFloor`.
 * - A suite is an "improvement" iff `before - after >= noiseFloor`.
 * - Suites that appear in current but not baseline land in `newSuites`,
 *   and vice versa for `droppedSuites`. These are not counted as
 *   regressions on their own.
 */
export function compareBaseline(
  current: BaselineSnapshot,
  baseline: BaselineSnapshot | null,
  options: CompareBaselineOptions = {},
): BaselineDelta {
  const noiseFloor = options.noiseFloor ?? 1;

  if (!baseline) {
    return {
      hasBaseline: false,
      aggregateDriftDelta: 0,
      regressions: [],
      improvements: [],
      newSuites: Object.keys(current.suites),
      droppedSuites: [],
      hasRegression: false,
    };
  }

  const currentSuites = new Set(Object.keys(current.suites));
  const baselineSuites = new Set(Object.keys(baseline.suites));

  const newSuites = [...currentSuites].filter(s => !baselineSuites.has(s));
  const droppedSuites = [...baselineSuites].filter(s => !currentSuites.has(s));

  const regressions: SuiteDelta[] = [];
  const improvements: SuiteDelta[] = [];

  for (const suite of currentSuites) {
    if (!baselineSuites.has(suite)) continue; // captured in newSuites
    const before = baseline.suites[suite].driftPercent;
    const after = current.suites[suite].driftPercent;
    const deltaPercent = after - before;

    if (deltaPercent >= noiseFloor) {
      regressions.push({ suite, before, after, deltaPercent });
    } else if (-deltaPercent >= noiseFloor) {
      improvements.push({ suite, before, after, deltaPercent });
    }
  }

  return {
    hasBaseline: true,
    aggregateDriftDelta: current.aggregateDrift - baseline.aggregateDrift,
    regressions,
    improvements,
    newSuites,
    droppedSuites,
    hasRegression: regressions.length > 0,
  };
}

/**
 * Render a baseline delta as a compact human-readable summary for the
 * reporter. Returns an empty string when there's nothing to report
 * (no regressions, no improvements, no new/dropped suites).
 */
export function formatBaselineDelta(delta: BaselineDelta): string {
  if (!delta.hasBaseline) {
    return 'No prior baseline — current run is the new baseline.';
  }

  const lines: string[] = [];

  if (delta.regressions.length > 0) {
    lines.push('Regressions:');
    for (const r of delta.regressions) {
      lines.push(
        `  - ${r.suite}: ${r.before.toFixed(1)}% → ${r.after.toFixed(1)}% (+${r.deltaPercent.toFixed(1)}pp)`,
      );
    }
  }

  if (delta.improvements.length > 0) {
    lines.push('Improvements:');
    for (const i of delta.improvements) {
      lines.push(
        `  - ${i.suite}: ${i.before.toFixed(1)}% → ${i.after.toFixed(1)}% (${i.deltaPercent.toFixed(1)}pp)`,
      );
    }
  }

  if (delta.newSuites.length > 0) {
    lines.push(`New suites: ${delta.newSuites.join(', ')}`);
  }

  if (delta.droppedSuites.length > 0) {
    lines.push(`Dropped suites: ${delta.droppedSuites.join(', ')}`);
  }

  if (lines.length === 0) {
    return `Aggregate drift unchanged within noise floor (${delta.aggregateDriftDelta >= 0 ? '+' : ''}${delta.aggregateDriftDelta.toFixed(2)}pp).`;
  }

  return lines.join('\n');
}
