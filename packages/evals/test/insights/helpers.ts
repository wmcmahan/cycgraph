/**
 * Shared builders for the telemetry-insights tests.
 */

import type {
  RunTelemetry,
  TelemetryLogLine,
  TelemetryNodeTiming,
  TelemetryNodeUsage,
} from '../../src/insights/types.js';

export function warn(event: string, nodeId?: string): TelemetryLogLine {
  return {
    level: 'warn',
    event,
    ...(nodeId ? { context: { node_id: nodeId } } : {}),
  };
}

export function usage(tokens: number, calls = 1): TelemetryNodeUsage {
  return { input_tokens: tokens, output_tokens: 0, cost_usd: 0, calls };
}

export function timing(totalMs: number, type = 'agent', visits = 1): TelemetryNodeTiming {
  return { type, total_ms: totalMs, visits };
}

/** One node's timing, which is all a run needs to be measurable. */
export function ran(totalMs: number): Record<string, TelemetryNodeTiming> {
  return { only: timing(totalMs) };
}

export function run(partial: Partial<RunTelemetry> & Pick<RunTelemetry, 'runId'>): RunTelemetry {
  return {
    workflow: 'wf',
    status: 'completed',
    logs: [],
    totalTokens: 0,
    assertions: [],
    ...partial,
  };
}
