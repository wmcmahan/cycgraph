/**
 * Fork-point addressing
 *
 * A fork point is one integer: the `sequence_id` of the first event a variant
 * does NOT replay. Everything callers can write — `'failure'`, "before the
 * writer node's second execution", "before the first node that read this
 * lesson" — is sugar that resolves to that integer against the base run's log.
 *
 * **Boundaries.** Each node execution writes a contiguous group:
 *
 *     node_started → action_dispatched → _track_* → _increment_iteration → _advance
 *
 * The main loop is sequential, so groups never interleave. The only point where
 * no node is mid-execution is immediately before a `node_started`, which makes
 * that the only valid fork point. Anywhere else, state holds an action whose
 * usage accounting has not landed, or a node that has emitted nothing yet —
 * states the run never persisted. An address landing mid-group is rejected
 * naming its node rather than silently rounded.
 *
 * @module replay/fork-point
 */

import type { WorkflowEvent } from '../persistence/event.js';
import type { ReplayStopContext } from './replay-events.js';

/**
 * Where to fork a recorded run.
 *
 * - `'start'` — before the first node, re-running the whole graph.
 * - `'failure'` — before the node that failed.
 * - `{ sequence }` — a raw sequence id, the canonical stored form.
 * - `{ beforeNode }` — the node re-executes under the change.
 * - `{ afterNode }` — the node's recorded output is kept; only what follows changes.
 * - `{ beforeIteration }` — a loop boundary.
 * - `{ beforeHumanInput }` — before the node that asked for approval.
 * - `{ beforeFirstWriteOf }` — before the node that first wrote a memory key.
 * - `{ beforeFirstReadOf }` — before the node whose retrieval injected a fact.
 * - `{ where }` — escape hatch predicate, evaluated during replay.
 * - `{ version }` — a persisted state snapshot, for the snapshot source only.
 */
export type ForkPoint =
  | 'start'
  | 'failure'
  | { sequence: number }
  | { version: number }
  | { beforeNode: string; occurrence?: number | 'last' }
  | { afterNode: string; occurrence?: number | 'last' }
  | { beforeIteration: number }
  | { beforeHumanInput: true }
  | { beforeFirstWriteOf: string }
  | { beforeFirstReadOf: string }
  | { where: (ctx: ReplayStopContext) => boolean };

/**
 * A resolved address, in the form the replay driver consumes.
 *
 * `sequence` covers every structural form and is resolved before any replay
 * runs. `predicate` is the `where` escape hatch, which needs reconstructed
 * state and so resolves during the replay itself. Either way the driver makes
 * exactly one pass.
 */
export type ForkPointPlan =
  | { kind: 'sequence'; sequenceId: number; nodeId?: string; description: string }
  | { kind: 'predicate'; stopBefore: (ctx: ReplayStopContext) => boolean; description: string };

/** One addressable fork point, as listed by {@link forkPoints}. */
export interface ForkPointSummary {
  /** Sequence id of the `node_started` — the value `{ sequence }` takes. */
  sequenceId: number;
  /** Node that was about to execute. */
  nodeId: string;
  /** Which execution of that node this was, 1-based. */
  occurrence: number;
  /** `iteration_count` at that point, derived from `_increment_iteration` events. */
  iteration: number;
}

/** An address that does not resolve against a run's log. */
export class ForkPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkPointError';
  }
}

/** Every `node_started`, in order, with its occurrence index and iteration. */
export function forkPoints(events: readonly WorkflowEvent[]): ForkPointSummary[] {
  const summaries: ForkPointSummary[] = [];
  const seen = new Map<string, number>();
  let iteration = 0;

  for (const event of events) {
    if (event.event_type === 'internal_dispatched' && event.internal_type === '_increment_iteration') {
      iteration++;
      continue;
    }
    if (event.event_type !== 'node_started' || !event.node_id) continue;

    const occurrence = (seen.get(event.node_id) ?? 0) + 1;
    seen.set(event.node_id, occurrence);
    summaries.push({
      sequenceId: event.sequence_id,
      nodeId: event.node_id,
      occurrence,
      iteration,
    });
  }

  return summaries;
}

/** One boundary inside a subgraph child, as listed by {@link childForkPoints}. */
export interface ChildForkPointSummary {
  /** Sequence id of the `child_node_started` in the parent's log. */
  sequenceId: number;
  /** Namespaced node id, e.g. `edit/locate`. */
  nodeId: string;
  /** The subgraph node whose child this boundary belongs to. */
  subgraphNodeId: string;
  /** The child's own run id, from `_child_run_id`. */
  childRunId?: string;
  /** Which execution of that namespaced node this was, 1-based. */
  occurrence: number;
}

/**
 * Every child-node boundary recorded in a run's log, in order.
 *
 * These are recorded but not yet addressable as fork points: forking at one
 * would need the child's state reconstructed and the subgraph node resumed
 * mid-child, which {@link planForkPoint} does not do yet. They exist so a
 * session's log is inspectable to its full depth, and so tooling can name
 * what happened inside a subgraph without loading anything else.
 */
export function childForkPoints(events: readonly WorkflowEvent[]): ChildForkPointSummary[] {
  const summaries: ChildForkPointSummary[] = [];
  const seen = new Map<string, number>();

  for (const event of events) {
    if (event.event_type !== 'child_node_started' || !event.node_id) continue;

    const occurrence = (seen.get(event.node_id) ?? 0) + 1;
    seen.set(event.node_id, occurrence);
    const childRunId = event.internal_payload?.['_child_run_id'];
    summaries.push({
      sequenceId: event.sequence_id,
      nodeId: event.node_id,
      subgraphNodeId: event.node_id.split('/')[0]!,
      ...(typeof childRunId === 'string' ? { childRunId } : {}),
      occurrence,
    });
  }

  return summaries;
}

/** Names of the nodes that executed, deduplicated, for error messages. */
function executedNodes(points: readonly ForkPointSummary[]): string {
  const names = [...new Set(points.map(p => p.nodeId))];
  return names.length > 0 ? names.join(', ') : '(none)';
}

/** Pick the requested execution of a node, or explain why it is not there. */
function selectOccurrence(
  points: readonly ForkPointSummary[],
  events: readonly WorkflowEvent[],
  nodeId: string,
  occurrence: number | 'last' | undefined,
  form: string,
): ForkPointSummary {
  const matches = points.filter(p => p.nodeId === nodeId);
  if (matches.length === 0) {
    // A namespaced id that DID record as a child boundary deserves a better
    // answer than "never executed": the point exists in the log, the driver
    // that resumes a run mid-child does not exist yet.
    if (nodeId.includes('/') && childForkPoints(events).some(p => p.nodeId === nodeId)) {
      const subgraphNodeId = nodeId.split('/')[0]!;
      throw new ForkPointError(
        `${form}: '${nodeId}' is inside subgraph node '${subgraphNodeId}'. Child boundaries are ` +
        `recorded (childForkPoints() lists them) but not yet addressable as fork points — ` +
        `fork { beforeNode: '${subgraphNodeId}' } to re-run the whole child under the change.`,
      );
    }
    throw new ForkPointError(
      `${form}: node '${nodeId}' never executed in this run. Nodes that did: ${executedNodes(points)}.`,
    );
  }
  if (occurrence === undefined) return matches[0];
  if (occurrence === 'last') return matches[matches.length - 1];
  if (occurrence < 1 || occurrence > matches.length) {
    throw new ForkPointError(
      `${form}: node '${nodeId}' executed ${matches.length} time(s), so occurrence ${occurrence} does not exist.`,
    );
  }
  return matches[occurrence - 1];
}

/**
 * Reject an address that lands inside a node's event group.
 *
 * Valid targets are a `node_started` event or one past the end of the log.
 * A mid-group sequence names the node whose execution it would split.
 */
function validateBoundary(events: readonly WorkflowEvent[], sequenceId: number): void {
  const last = events.length > 0 ? events[events.length - 1].sequence_id : -1;
  if (sequenceId > last) return;

  const target = events.find(e => e.sequence_id === sequenceId);
  if (!target) {
    const first = events.length > 0 ? events[0].sequence_id : 0;
    throw new ForkPointError(
      `sequence ${sequenceId} is not in this run's log. Available: ${first}..${last}. ` +
      `Sequences below ${first} were removed by event-log compaction.`,
    );
  }
  if (target.event_type === 'node_started') return;

  const enclosing = [...events]
    .filter(e => e.sequence_id < sequenceId && e.event_type === 'node_started')
    .pop();
  const within = enclosing?.node_id ? ` It falls inside '${enclosing.node_id}'s execution.` : '';
  throw new ForkPointError(
    `sequence ${sequenceId} is a '${target.event_type}' event, not a node boundary.${within} ` +
    `A fork must start where no node is mid-execution — use { beforeNode } or forkPoints() to find one.`,
  );
}

/** The sequence one past the log's end: fork after everything that happened. */
function endOfLog(events: readonly WorkflowEvent[]): number {
  return events.length > 0 ? events[events.length - 1].sequence_id + 1 : 0;
}

/** First action whose `update_memory` payload writes `key`. */
function firstWriteOf(events: readonly WorkflowEvent[], key: string): WorkflowEvent | undefined {
  return events.find(e => {
    if (e.event_type !== 'action_dispatched' || e.action?.type !== 'update_memory') return false;
    const updates = e.action.payload?.updates;
    return typeof updates === 'object' && updates !== null && key in updates;
  });
}

/** First action carrying `factId` in its lesson-provenance payload. */
function firstReadOf(events: readonly WorkflowEvent[], factId: string): WorkflowEvent | undefined {
  return events.find(e => {
    if (e.event_type !== 'action_dispatched' || !e.action) return false;
    const payload = e.action.payload as Record<string, unknown>;
    // Agent nodes carry provenance under the wire key inside `updates`;
    // supervisors carry it on the handoff/set_status payload itself.
    const updates = payload.updates as Record<string, unknown> | undefined;
    const registries = [updates?._lesson_provenance, payload.lesson_provenance];
    return registries.some(registry =>
      typeof registry === 'object' && registry !== null &&
      Object.values(registry as Record<string, unknown>).some(entry => {
        const ids = (entry as { fact_ids?: unknown })?.fact_ids;
        return Array.isArray(ids) && ids.includes(factId);
      }),
    );
  });
}

/** The `node_started` that opened the group containing `sequenceId`. */
function groupStart(
  events: readonly WorkflowEvent[],
  sequenceId: number,
): WorkflowEvent | undefined {
  return [...events]
    .filter(e => e.sequence_id <= sequenceId && e.event_type === 'node_started')
    .pop();
}

/** The first `node_started` after `sequenceId`, or one past the log's end. */
function nextBoundaryAfter(events: readonly WorkflowEvent[], sequenceId: number): number {
  const next = events.find(e => e.sequence_id > sequenceId && e.event_type === 'node_started');
  return next ? next.sequence_id : endOfLog(events);
}

/**
 * Resolve a {@link ForkPoint} against a run's event log.
 *
 * @throws {ForkPointError} If the address names something the run never did,
 *   lands inside a node's execution, or falls behind the compaction boundary.
 */
export function planForkPoint(
  events: readonly WorkflowEvent[],
  point: ForkPoint,
): ForkPointPlan {
  const points = forkPoints(events);

  const at = (sequenceId: number, nodeId: string | undefined, description: string): ForkPointPlan => {
    validateBoundary(events, sequenceId);
    return { kind: 'sequence', sequenceId, nodeId, description };
  };

  if (point === 'start') {
    if (points.length === 0) {
      throw new ForkPointError(`'start': this run never started a node, so there is nothing to fork.`);
    }
    const first = points[0];
    return at(first.sequenceId, first.nodeId, `before the first node ('${first.nodeId}')`);
  }

  if (point === 'failure') {
    const failure = events.find(
      e => e.event_type === 'internal_dispatched' && e.internal_type === '_fail',
    );
    if (!failure) {
      throw new ForkPointError(
        `'failure': this run did not fail, so there is no failure to fork before. ` +
        `Name a point explicitly — forkPoints() lists them.`,
      );
    }
    const start = groupStart(events, failure.sequence_id);
    if (!start?.node_id) {
      throw new ForkPointError(
        `'failure': the run failed before any node started (sequence ${failure.sequence_id}).`,
      );
    }
    return at(start.sequence_id, start.node_id, `before the failing node ('${start.node_id}')`);
  }

  if ('where' in point) {
    return { kind: 'predicate', stopBefore: point.where, description: 'a caller predicate' };
  }

  if ('version' in point) {
    throw new ForkPointError(
      `{ version: ${point.version} } addresses a persisted state snapshot, not a position in the ` +
      `event log. Pass source: 'snapshot' to fork from one, or use { sequence } / { beforeNode } here.`,
    );
  }

  if ('sequence' in point) {
    const start = groupStart(events, point.sequence);
    return at(point.sequence, start?.node_id, `sequence ${point.sequence}`);
  }

  if ('beforeNode' in point) {
    const form = `{ beforeNode: '${point.beforeNode}' }`;
    const match = selectOccurrence(points, events, point.beforeNode, point.occurrence, form);
    return at(
      match.sequenceId,
      match.nodeId,
      `before '${match.nodeId}' execution ${match.occurrence}`,
    );
  }

  if ('afterNode' in point) {
    const form = `{ afterNode: '${point.afterNode}' }`;
    const match = selectOccurrence(points, events, point.afterNode, point.occurrence, form);
    const sequenceId = nextBoundaryAfter(events, match.sequenceId);
    const start = groupStart(events, sequenceId);
    return at(
      sequenceId,
      sequenceId > match.sequenceId ? start?.node_id : undefined,
      `after '${match.nodeId}' execution ${match.occurrence}`,
    );
  }

  if ('beforeIteration' in point) {
    const match = points.find(p => p.iteration === point.beforeIteration);
    if (!match) {
      const reached = points.length > 0 ? points[points.length - 1].iteration : 0;
      throw new ForkPointError(
        `{ beforeIteration: ${point.beforeIteration} }: this run reached iteration ${reached}.`,
      );
    }
    return at(match.sequenceId, match.nodeId, `before iteration ${point.beforeIteration}`);
  }

  if ('beforeHumanInput' in point) {
    const request = events.find(
      e => e.event_type === 'action_dispatched' && e.action?.type === 'request_human_input',
    );
    if (!request) {
      throw new ForkPointError(`{ beforeHumanInput }: this run never asked for human input.`);
    }
    const start = groupStart(events, request.sequence_id);
    return at(
      start!.sequence_id,
      start!.node_id,
      `before the approval node ('${start!.node_id}')`,
    );
  }

  if ('beforeFirstWriteOf' in point) {
    const write = firstWriteOf(events, point.beforeFirstWriteOf);
    if (!write) {
      throw new ForkPointError(
        `{ beforeFirstWriteOf: '${point.beforeFirstWriteOf}' }: no node wrote that key in this run.`,
      );
    }
    const start = groupStart(events, write.sequence_id);
    return at(
      start!.sequence_id,
      start!.node_id,
      `before '${start!.node_id}' first wrote '${point.beforeFirstWriteOf}'`,
    );
  }

  const read = firstReadOf(events, point.beforeFirstReadOf);
  if (!read) {
    throw new ForkPointError(
      `{ beforeFirstReadOf: '${point.beforeFirstReadOf}' }: that fact was not injected into this run. ` +
      `Retriever adapters that drop fact ids record no provenance, which looks identical from here.`,
    );
  }
  const start = groupStart(events, read.sequence_id);
  return at(
    start!.sequence_id,
    start!.node_id,
    `before '${start!.node_id}' read fact ${point.beforeFirstReadOf}`,
  );
}
