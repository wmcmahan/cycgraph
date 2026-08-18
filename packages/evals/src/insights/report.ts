/**
 * Findings report
 *
 * Runs every detector over a corpus and ranks what comes back. Ranking is the
 * product: a list of everything wrong, unordered, is a list nobody reads.
 *
 * @module insights/report
 */

import type { Detector, Finding, FindingSeverity, RunTelemetry } from './types.js';
import { detectSignals } from './signals.js';
import { detectOutliers } from './outliers.js';
import { detectAssertionFailures } from './assertions.js';

/** Every detector, in the order their findings are gathered. */
export const DETECTORS: readonly Detector[] = [
  detectAssertionFailures,
  detectSignals,
  detectOutliers,
];

/** What a detection pass produced. */
export interface InsightsReport {
  /** Runs examined. */
  runs: number;
  /** Distinct workflows in the corpus. */
  workflows: number;
  /** Ranked, most worth attention first. */
  findings: Finding[];
  /** Findings per severity, for a one-line summary. */
  counts: Record<FindingSeverity, number>;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Rank findings for a reader.
 *
 * Severity first, then how much of the corpus exhibits it. The rate matters
 * more than the raw count: a signal in 4 of 5 runs of a rare workflow is a
 * stronger claim than one in 10 of 400 runs of a common one.
 */
function rank(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;

  const rateA = a.evidence.runs / Math.max(1, a.evidence.of);
  const rateB = b.evidence.runs / Math.max(1, b.evidence.of);
  if (rateA !== rateB) return rateB - rateA;

  // Ties broken by id so a report is stable between passes over one corpus,
  // which is what lets two reports be diffed.
  return a.id < b.id ? -1 : 1;
}

/** Run every detector over a corpus and rank what they find. */
export function buildInsightsReport(
  runs: readonly RunTelemetry[],
  detectors: readonly Detector[] = DETECTORS,
): InsightsReport {
  const findings = detectors.flatMap(detect => detect(runs)).sort(rank);

  const counts: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;

  return {
    runs: runs.length,
    workflows: new Set(runs.map(r => r.workflow)).size,
    findings,
    counts,
  };
}

/** Render a report as plain text. */
export function formatInsightsReport(report: InsightsReport): string {
  if (report.findings.length === 0) {
    return `Nothing found across ${report.runs} run(s) of ${report.workflows} workflow(s).`;
  }

  const lines = [
    `${report.findings.length} finding(s) across ${report.runs} run(s) of ${report.workflows} workflow(s)`,
    `  ${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low`,
    '',
  ];

  for (const finding of report.findings) {
    lines.push(`[${finding.severity}] ${finding.title}`);
    lines.push(`  ${finding.detail}`);
    lines.push(`  addresses: ${finding.addresses}`);
    const seen = finding.evidence.lastSeen ? `, last seen ${finding.evidence.lastSeen}` : '';
    lines.push(`  ${finding.evidence.sampleRunIds.length} sample run(s): ${finding.evidence.sampleRunIds.join(', ')}${seen}`);
    lines.push('');
  }

  return lines.join('\n');
}
