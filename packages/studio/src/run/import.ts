/**
 * Import: external runs into the artifact tree
 *
 * A run recorded by any process into the shared persistence is already
 * browsable and forkable; importing reconstructs the artifact directory the
 * sensing layer reads, so insights, tune, and the watcher see it too. The
 * event log yields the timeline and per-node timings, the final state
 * snapshot yields usage, and the run row yields status. What cannot be
 * conjured is left honestly absent: engine log lines went to the recording
 * process's logger, and evals exist only where a scenario declared them.
 *
 * The imported workflow id is the graph's name, which is the natural join:
 * a config-declared scenario building a graph of the same name gives the
 * imported corpus a knob source, and `tune` works end to end.
 *
 * @module run/import
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHistory } from './history.js';
import type { RunMeta, RunUsage } from './recorder.js';
import type { Stack } from '../stack/index.js';

/** What importing one run produced, or why it did not. */
export interface ImportOutcome {
  runId: string;
  imported: boolean;
  /** Workflow id the artifacts carry (the graph's name, slugged). */
  workflow?: string;
  dir?: string;
  /** node:complete lines written. */
  timings?: number;
  reason?: string;
}

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'external';
}

interface TimedEvent {
  event_type: string;
  node_id?: string | null;
  created_at: Date;
}

const COMPLETIONS_BY_START = {
  node_started: new Set(['action_dispatched', 'internal_dispatched']),
  child_node_started: new Set(['child_action_dispatched', 'child_internal_dispatched']),
} as const;

/**
 * Per-visit node timings from the event log: a start event paired with the
 * dispatch of the same family — `node_started` with the node's own action,
 * `child_node_started` with a child dispatch. The family split matters for
 * containers: a subgraph's child traffic carries the container's bare id
 * for the child run's internals, and closing on those would time the
 * container as its first child's latency.
 */
function nodeCompletions(events: readonly TimedEvent[], typeOf: (id: string) => string): Array<{
  node_id: string;
  node_type: string;
  duration_ms: number;
}> {
  const completions: Array<{ node_id: string; node_type: string; duration_ms: number }> = [];
  const open = new Map<string, { at: Date; closers: ReadonlySet<string> }>();

  for (const event of events) {
    if (!event.node_id) continue;
    const closers = COMPLETIONS_BY_START[event.event_type as keyof typeof COMPLETIONS_BY_START];
    if (closers) {
      open.set(event.node_id, { at: event.created_at, closers });
      continue;
    }
    const started = open.get(event.node_id);
    // A container's child events carry its bare id for the child's own
    // run-level internals; only the container's own dispatch closes it.
    if (started === undefined || !started.closers.has(event.event_type)) continue;
    const startedAt = started.at;
    open.delete(event.node_id);
    completions.push({
      node_id: event.node_id,
      node_type: typeOf(event.node_id),
      duration_ms: Math.max(0, event.created_at.getTime() - startedAt.getTime()),
    });
  }
  return completions;
}


/**
 * Node types for the whole composition, keyed the way the unified log
 * namespaces them: a subgraph node's children under `container/child`,
 * recursively. Children resolve through persistence, where the run's
 * closure saved them.
 */
async function namespacedTypes(
  stack: Stack,
  graph: Awaited<ReturnType<Stack['persistence']['loadGraph']>>,
  prefix: string,
  seen: Set<string> = new Set(),
): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  for (const node of graph?.nodes ?? []) {
    types.set(`${prefix}${node.id}`, node.type);
    const childId = node.subgraph_config?.subgraph_id;
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    const child = await stack.persistence.loadGraph(childId);
    for (const [id, type] of await namespacedTypes(stack, child, `${prefix}${node.id}/`, seen)) {
      types.set(id, type);
    }
  }
  return types;
}

/** Reconstruct one run's artifacts from persistence and the event log. */
export async function importRun(stack: Stack, runId: string): Promise<ImportOutcome> {
  const row = await stack.persistence.loadWorkflowRun(runId);
  if (!row) return { runId, imported: false, reason: 'no such run in persistence' };

  const existing = await loadHistory(stack.config.artifactRoot, { limit: 1000 });
  if (existing.some((entry) => entry.meta.runId === runId)) {
    return { runId, imported: false, reason: 'already in the artifact tree' };
  }

  const events = await stack.eventLog.loadEvents(runId);
  if (events.length === 0) {
    return { runId, imported: false, reason: 'no recorded events — nothing to reconstruct' };
  }

  const graph = await stack.persistence.loadGraph(row.graph_id);
  const workflow = slug(graph?.name ?? 'external');
  const types = await namespacedTypes(stack, graph, '');
  const typeOf = (id: string): string => types.get(id) ?? 'unknown';

  const startedAt = events[0]!.created_at;
  const endedAt = events[events.length - 1]!.created_at;
  const state = await stack.persistence.loadLatestWorkflowState(runId);

  const dir = join(stack.config.artifactRoot, 'runs', `${workflow}-${runId}`);
  await mkdir(dir, { recursive: true });

  const meta: RunMeta = {
    runId,
    scenarioId: workflow,
    params: {},
    stack: stack.config,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    status: state?.status ?? row.status,
    imported: true,
  };
  const usage: RunUsage = {
    totalTokens: state?.total_tokens_used ?? 0,
    totalCostUsd: state?.total_cost_usd ?? 0,
    nodesVisited: state?.visited_nodes.length ?? 0,
    ...(Object.keys(state?.node_breakdown ?? {}).length > 0
      ? { byNode: state!.node_breakdown }
      : {}),
  };
  const completions = nodeCompletions(events, typeOf);

  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  await writeFile(join(dir, 'usage.json'), JSON.stringify(usage, null, 2));
  await writeFile(join(dir, 'evals.json'), JSON.stringify([], null, 2));
  await writeFile(join(dir, 'events.ndjson'), completions
    .map((line) => JSON.stringify({ type: 'node:complete', ...line }))
    .join('\n') + (completions.length > 0 ? '\n' : ''));

  return { runId, imported: true, workflow, dir, timings: completions.length };
}

/**
 * Import every persisted run the artifact tree does not hold yet. Child and
 * fork runs are skipped: they belong to their parent's story, and the
 * sensing layer already excludes lineage-bearing runs from profiles.
 */
export async function importAll(stack: Stack, options: { limit?: number } = {}): Promise<ImportOutcome[]> {
  const rows = await stack.persistence.listWorkflowRuns({ limit: options.limit ?? 200 });
  const existing = new Set(
    (await loadHistory(stack.config.artifactRoot, { limit: 1000 })).map((entry) => entry.meta.runId));

  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    if (row.parent_run_id) continue;
    if (existing.has(row.id)) continue;
    outcomes.push(await importRun(stack, row.id));
  }
  return outcomes;
}
