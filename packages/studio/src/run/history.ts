/**
 * Run history
 *
 * Reads what past runs recorded. Nothing here talks to Postgres, Jaeger, or a
 * model: the artifact tree is the index, which is why history works with the
 * stack down and why it outlives a `docker-compose down -v`.
 *
 * @module run/history
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssertionResult } from '@cycgraph/orchestrator';
import type { RunMeta, RunUsage } from './recorder.js';

/** One past run, as far as its artifacts describe it. */
export interface HistoryEntry {
  dir: string;
  meta: RunMeta;
  usage: RunUsage;
  evals: AssertionResult[];
  /** Assertions that held, over assertions checked. */
  passed: number;
  total: number;
}

/** What to include. */
export interface HistoryQuery {
  scenarioId?: string;
  limit?: number;
  /** Only runs that did not do what their scenario claimed. */
  failedOnly?: boolean;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Whether a run did what its scenario claimed it would.
 *
 * Not "did it complete": many scenarios assert a failure, and one that fails
 * exactly as predicted is a correct run. The assertions are the expectation,
 * so they decide. A run carrying none falls back to the workflow status,
 * which is all there is to go on.
 */
export function isClean(entry: HistoryEntry): boolean {
  if (entry.total > 0) return entry.passed === entry.total;
  return entry.meta.status === 'completed';
}

/**
 * Load past runs, newest first.
 *
 * A directory missing `meta.json` is skipped rather than failing the listing:
 * a run killed between `mkdir` and the first write is exactly the kind of
 * thing the crash scenarios produce.
 */
export async function loadHistory(
  artifactRoot: string,
  query: HistoryQuery = {},
): Promise<HistoryEntry[]> {
  const root = join(artifactRoot, 'runs');

  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const name of dirs) {
    const dir = join(root, name);
    const meta = await readJson<RunMeta>(join(dir, 'meta.json'));
    if (!meta) continue;
    if (query.scenarioId && meta.scenarioId !== query.scenarioId) continue;

    const usage = (await readJson<RunUsage>(join(dir, 'usage.json')))
      ?? { totalTokens: 0, totalCostUsd: 0, nodesVisited: 0 };
    const evals = (await readJson<AssertionResult[]>(join(dir, 'evals.json'))) ?? [];

    entries.push({
      dir,
      meta,
      usage,
      evals,
      passed: evals.filter((result) => result.passed).length,
      total: evals.length,
    });
  }

  entries.sort((a, b) => Date.parse(b.meta.startedAt) - Date.parse(a.meta.startedAt));

  const filtered = query.failedOnly ? entries.filter((entry) => !isClean(entry)) : entries;
  return filtered.slice(0, query.limit ?? 20);
}

/** A run with the forks taken from it, recursively. */
export interface RunTree {
  entry: HistoryEntry;
  forks: RunTree[];
}

/**
 * Group forks under the runs they forked.
 *
 * A fork is a run of the same scenario, so a flat listing puts it next to its
 * parent as an unexplained near-duplicate. Nesting says what it is.
 *
 * A fork whose parent falls outside the window stays at the top level rather
 * than disappearing: the listing is limited and sorted by time, so a parent can
 * legitimately be older than the cutoff, and dropping its forks would hide runs
 * that exist.
 */
export function nestForks(entries: readonly HistoryEntry[]): RunTree[] {
  const nodes = new Map<string, RunTree>(
    entries.map((entry) => [entry.meta.runId, { entry, forks: [] }]),
  );

  const roots: RunTree[] = [];
  for (const node of nodes.values()) {
    const parentId = node.entry.meta.parentRunId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.forks.push(node);
    else roots.push(node);
  }

  // Oldest fork first: forks read as a sequence of attempts against one run,
  // which is the order they were made in, not the reverse.
  const byAge = (a: RunTree, b: RunTree) =>
    Date.parse(a.entry.meta.startedAt) - Date.parse(b.entry.meta.startedAt);
  for (const node of nodes.values()) node.forks.sort(byAge);

  return roots;
}

/** Resolve which recorded run a command means. */
export async function findRun(
  artifactRoot: string,
  target?: string,
): Promise<HistoryEntry | null> {
  const entries = await loadHistory(artifactRoot, { limit: 500 });
  if (entries.length === 0) return null;
  if (!target) return entries[0] ?? null;

  // Newest-first, so the first match of a scenario name is its latest run and
  // a run-id prefix identifies one exactly.
  return entries.find((entry) =>
    entry.meta.scenarioId === target
    || entry.meta.runId === target
    || entry.meta.runId.startsWith(target)) ?? null;
}

/** One recorded log line, as the engine's `LogSink` emitted it. */
export interface RunLogLine {
  timestamp: string;
  level: string;
  event: string;
  /** Span the line was emitted under, when the run was traced. */
  span_id?: string;
  context?: Record<string, unknown>;
}

/**
 * The log lines a run recorded.
 *
 * Tolerates a truncated final line: a killed process leaves one, and the rest
 * of the file is still worth reading.
 */
export async function loadRunLogs(dir: string): Promise<RunLogLine[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'logs.ndjson'), 'utf8');
  } catch {
    return [];
  }

  const lines: RunLogLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as RunLogLine);
    } catch {
      // Partial write from a run that was killed mid-flush.
    }
  }
  return lines;
}

/**
 * The parameters that differ across a set of runs.
 *
 * A column every run agrees on says nothing about why they differ, and a
 * history of one scenario is mostly such columns.
 */
export function varyingParams(entries: readonly HistoryEntry[]): string[] {
  const seen = new Map<string, Set<string>>();

  for (const entry of entries) {
    const params = (entry.meta.params ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(params)) {
      const rendered = JSON.stringify(value) ?? String(value);
      const values = seen.get(key) ?? new Set<string>();
      values.add(rendered);
      seen.set(key, values);
    }
  }

  return [...seen.entries()].filter(([, values]) => values.size > 1).map(([key]) => key);
}

/** What one node spent, summed over the visits a run made to it. */
export interface NodeTiming {
  /** Node type, as the engine stamped it on the completion event. */
  type: string;
  /** Execution time, excluding anything the run spent not executing. */
  total_ms: number;
  /** Times the run entered the node. */
  visits: number;
}

/**
 * Per-node execution time, read from the run's event stream.
 *
 * Wall clock is not this number and is not a substitute for it. An
 * approval-gated run sits paused waiting for a person, so its wall clock
 * measures the person: one recorded here spent 31 seconds of wall clock on 4
 * milliseconds of node execution. Summed node time is what the workflow
 * actually did.
 *
 * Cheap despite reading the whole stream, because the filter is a substring
 * test and only the surviving lines are parsed. Token deltas are the bulk of
 * an event log and none of them is parsed.
 */
export async function loadNodeTiming(dir: string): Promise<Record<string, NodeTiming>> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'events.ndjson'), 'utf8');
  } catch {
    return {};
  }

  const timing: Record<string, NodeTiming> = {};
  for (const line of raw.split('\n')) {
    if (!line.includes('"node:complete"')) continue;

    let event: { node_id?: string; node_type?: string; duration_ms?: number };
    try {
      event = JSON.parse(line);
    } catch {
      // Partial write from a run that was killed mid-flush.
      continue;
    }
    if (!event.node_id) continue;

    const entry = timing[event.node_id] ?? { type: event.node_type ?? 'unknown', total_ms: 0, visits: 0 };
    entry.total_ms += event.duration_ms ?? 0;
    entry.visits++;
    timing[event.node_id] = entry;
  }

  return timing;
}

/**
 * Execution time from a node's first visit to the end of the run.
 *
 * What a fork taken immediately before that node is about to re-run, predicted
 * from what the base run spent on the same stretch. The engine's own
 * `estimateTailCost` answers the same question in dollars, which is zero for
 * every local model, so the tail is measured in the unit the sweep is actually
 * optimising.
 *
 * Reads completions in recorded order rather than the aggregated per-node
 * totals, because a node visited four times contributes only the visits inside
 * the tail.
 */
export async function loadTailMs(dir: string, fromNodeId: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'events.ndjson'), 'utf8');
  } catch {
    return undefined;
  }

  let inTail = false;
  let total = 0;
  let seen = false;

  for (const line of raw.split('\n')) {
    if (!line.includes('"node:complete"')) continue;

    let event: { node_id?: string; duration_ms?: number };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.node_id === fromNodeId) inTail = true;
    if (!inTail) continue;

    seen = true;
    total += event.duration_ms ?? 0;
  }

  return seen ? total : undefined;
}
