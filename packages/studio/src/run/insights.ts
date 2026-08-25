/**
 * Telemetry insights over recorded runs
 *
 * Adapts the artifact tree into the normalised shape `@cycgraph/evals` reads,
 * then runs the detectors over it. Nothing here interprets telemetry itself:
 * the detectors are shared so a hosted control plane reading production runs
 * reaches the same conclusions from the same evidence.
 *
 * @module run/insights
 */

import { buildInsightsReport, buildWorkflowProfile } from '@cycgraph/evals';
import type { InsightsReport, RunTelemetry, TelemetryLogLine, WorkflowProfile } from '@cycgraph/evals';
import { loadHistory, loadNodeTiming, loadRunLogs } from './history.js';
import type { HistoryEntry } from './history.js';

/** How many runs a corpus reads by default. */
const DEFAULT_LIMIT = 500;

/** \`RunMeta.params\` is \`unknown\`, since a scenario decides its own shape. */
function isParams(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Levels the detectors read; everything else is volume. */
function isReportedLevel(level: string): level is TelemetryLogLine['level'] {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error';
}

/**
 * One recorded run, in the detectors' shape.
 *
 * The scenario id is the workflow identity rather than the graph id: two runs
 * of one scenario with different parameters are the same workflow for
 * comparison, and a rebuilt graph gets a fresh id every run.
 */
export async function toTelemetry(entry: HistoryEntry): Promise<RunTelemetry> {
  const [logs, nodeTiming] = await Promise.all([
    loadRunLogs(entry.dir),
    loadNodeTiming(entry.dir),
  ]);

  return {
    runId: entry.meta.runId,
    workflow: entry.meta.scenarioId,
    status: entry.meta.status ?? 'unknown',
    ...(entry.meta.durationMs !== undefined ? { durationMs: entry.meta.durationMs } : {}),
    startedAt: entry.meta.startedAt,
    logs: logs
      .filter((line) => isReportedLevel(line.level))
      .map((line) => ({
        level: line.level as TelemetryLogLine['level'],
        event: line.event,
        ...(line.context ? { context: line.context } : {}),
      })),
    totalTokens: entry.usage.totalTokens,
    ...(entry.usage.byNode ? { byNode: entry.usage.byNode } : {}),
    ...(Object.keys(nodeTiming).length > 0 ? { nodeTiming } : {}),
    ...((): { params?: Record<string, unknown> } => {
      // Applied proposals are configuration the run was given, so they join
      // the parameters: two runs under different accepted sets are different
      // populations, and folding the ids in here is what keeps the duration
      // buckets and the profile honest about it.
      const params = isParams(entry.meta.params) ? { ...entry.meta.params } : {};
      if (entry.meta.appliedProposals?.length) params['applied'] = [...entry.meta.appliedProposals].sort();
      return Object.keys(params).length > 0 ? { params } : {};
    })(),
    ...(entry.meta.stack?.model ? { model: entry.meta.stack.model } : {}),
    assertions: entry.evals.map((result) => ({
      type: result.assertion.type,
      passed: result.passed,
      ...(result.message ? { message: result.message } : {}),
    })),
  };
}

/** What to read. */
export interface InsightsQuery {
  scenarioId?: string;
  limit?: number;
}

/**
 * Read the artifact tree and report what the detectors find in it.
 *
 * Ordinary runs only. A fork is a measurement about a hypothetical — a
 * deliberately mutated configuration, often mutated precisely so it fails —
 * and detection is about what the workflow does as authored. Counting a
 * sweep's failing arms as the workflow's failures would have the system's own
 * experiments polluting the observations that motivate them.
 */
export async function inspectRuns(
  artifactRoot: string,
  query: InsightsQuery = {},
): Promise<InsightsReport> {
  const entries = await loadHistory(artifactRoot, {
    ...(query.scenarioId ? { scenarioId: query.scenarioId } : {}),
    limit: query.limit ?? DEFAULT_LIMIT,
  });

  const ordinary = entries.filter((entry) => !entry.meta.parentRunId);
  const telemetry = await Promise.all(ordinary.map(toTelemetry));
  return buildInsightsReport(telemetry);
}

/**
 * Where one workflow spends itself, across the runs recorded of it.
 *
 * Separate from `inspectRuns` because a profile is not a finding: nothing in
 * it is wrong, and it is read to decide what to optimise rather than what to
 * fix.
 */
export async function profileWorkflow(
  artifactRoot: string,
  scenarioId: string,
  limit = DEFAULT_LIMIT,
): Promise<WorkflowProfile | undefined> {
  const entries = await loadHistory(artifactRoot, { scenarioId, limit });
  // As authored: a fork ran a mutated configuration, and folding its
  // temperatures and timings into the profile describes the sweep, not the
  // workflow.
  const ordinary = entries.filter((entry) => !entry.meta.parentRunId);
  const telemetry = await Promise.all(ordinary.map(toTelemetry));
  return buildWorkflowProfile(scenarioId, telemetry);
}
