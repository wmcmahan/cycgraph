/**
 * Recency
 *
 * A corpus is a time series, and a report that treats it as a set says a
 * problem fixed last week is happening now. Every finding carries when it was
 * last seen so a reader can tell the difference.
 *
 * @module insights/recency
 */

import type { RunTelemetry } from './types.js';

/** When each run started, for looking up a group's recency by run id. */
export function startTimes(runs: readonly RunTelemetry[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const run of runs) {
    if (run.startedAt) times.set(run.runId, run.startedAt);
  }
  return times;
}

/** The most recent start among a set of runs, when any of them recorded one. */
export function latestStart(runIds: Iterable<string>, times: ReadonlyMap<string, string>): string | undefined {
  let latest: string | undefined;
  for (const runId of runIds) {
    const at = times.get(runId);
    // ISO-8601 UTC sorts lexicographically, which is what the recorder writes.
    if (at && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/** The `lastSeen` evidence field, omitted when no run recorded a start time. */
export function seenAt(runIds: Iterable<string>, times: ReadonlyMap<string, string>): { lastSeen?: string } {
  const lastSeen = latestStart(runIds, times);
  return lastSeen ? { lastSeen } : {};
}
