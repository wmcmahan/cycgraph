/**
 * forkInChild() — fork a recorded run at a point inside a subgraph child
 *
 * B2b's second half: the `child_*` events a parent's log carries become
 * addressable. A mid-child fork decomposes into two ordinary forks rather
 * than teaching the engine a new resume mode:
 *
 * 1. **The child fork.** The child's session is extracted from the parent's
 *    log — `child_*` types translated back to their plain forms, the
 *    subgraph node's namespace stripped, sequences renumbered — and handed
 *    to `fork()` as a self-contained base run. Everything the fork driver
 *    already does (prefix replay from the recorded seed, overlays, the
 *    side-effect guard, memoization) applies to the child unchanged.
 * 2. **The parent continuation.** The child fork's final memory is mapped
 *    through the subgraph node's `output_mapping`, and the parent is forked
 *    at the subgraph node with a `change.output` substituting that result —
 *    so the subgraph node never re-executes, and the parent tail runs under
 *    the same guard and memoization as any fork.
 *
 * The decomposition is honest about what a mid-child fork is: a variant of
 * the child, plus what the parent would have done with the variant's
 * result. Each half is a `ForkResult` with its own run id, diff, and log.
 *
 * One nesting level per call. The extracted child log preserves deeper
 * `child_*` events under their remaining prefixes, so a grandchild point is
 * reachable by forking in the child's child — not yet composed here.
 *
 * @module replay/fork-child
 */

import type { Graph } from '../graph/graph.js';
import type { EventLogWriter } from '../persistence/event-log.js';
import type { AgentRegistry } from '../persistence/interfaces.js';
import type { WorkflowEvent, NewWorkflowEvent, EventType } from '../persistence/event.js';
import type { WorkflowState } from '../state/state.js';
import { fork, absorbRecordedRun, type ForkOptions, type ForkResult, type ForkableRun } from './fork.js';
import { childForkPoints, forkPoints, ForkPointError } from './fork-point.js';
import { ForkError } from './errors.js';
import { ChangeSchema, type Change } from './mutations.js';
import { mapOutbound, type BoundaryFailure } from '../execution/nodes/boundary.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('replay.fork-child');

/** Options for {@link forkInChild}. */
export interface ChildForkOptions {
  /**
   * The child boundary to fork at, namespaced: `{ beforeNode: 'edit/locate' }`.
   * `childForkPoints()` lists what a run's log holds.
   */
  at: { beforeNode: string; occurrence?: number | 'last' };
  /**
   * What the child does differently. Targets are child-relative
   * (`'locate'`); the subgraph namespace is tolerated and stripped.
   */
  change?: Change | Change[];
  /** The parent run's event log. */
  eventLog?: EventLogWriter;
  /** The graph the parent run executed. */
  graph?: Graph;
  /** Registry holding the parent's AND the child's agents. */
  registry?: AgentRegistry;
  /** Resolves the child graph from the subgraph node's `subgraph_id`. */
  loadGraph?: (graphId: string) => Promise<Graph | null>;
  /** Extra runner options, threaded to both forks. */
  runner?: ForkOptions['runner'];
  /** Side-effect and memoization policy for the child fork. */
  policy?: ForkOptions['policy'];
  /** Policy for the parent continuation. Defaults to `policy`. */
  parentPolicy?: ForkOptions['policy'];
  /** Answers approval gates the parent tail reaches. */
  hitl?: ForkOptions['hitl'];
  /** Proceed even when the inherited budget cannot cover the tails. */
  ignoreBudget?: boolean;
  /** Run id for the parent continuation, for callers that record it. */
  runId?: string;
  /** Run id for the child variant, for callers that record it. */
  childVariantRunId?: string;
  /**
   * Run the parent tail with the child variant's mapped output. On by
   * default; off returns the child fork alone.
   */
  continueParent?: boolean;
}

/** What a mid-child fork produced. */
export interface ChildForkResult {
  /** The subgraph node whose child was forked. */
  subgraphNodeId: string;
  /** The recorded child session the fork diverged from. */
  childBaseRunId: string;
  /** The child variant. */
  child: ForkResult;
  /** The parent tail, run with the child variant's mapped output. */
  parent?: ForkResult;
  /** Why the parent continuation did not run, when it did not. */
  parentSkipped?: string;
}

const PLAIN_TYPE: Partial<Record<EventType, EventType>> = {
  child_workflow_started: 'workflow_started',
  child_node_started: 'node_started',
  child_action_dispatched: 'action_dispatched',
  child_internal_dispatched: 'internal_dispatched',
};

/** The extracted child session, renumbered as a self-contained log. */
interface ExtractedChildLog {
  events: WorkflowEvent[];
  /** Parent `sequence_id` → extracted `sequence_id`. */
  sequenceMap: Map<number, number>;
}

/**
 * Extract one child session from a parent log.
 *
 * The child's own events (those authored under `childRunId`) translate back
 * to their plain types; deeper descendants keep their `child_*` types and
 * lose one prefix level, so the extracted log is itself a valid
 * child-bearing log. Sessions are delimited by the direct
 * `child_workflow_started` markers, so events from other executions of the
 * same subgraph node never leak in.
 */
export function extractChildLog(
  events: readonly WorkflowEvent[],
  subgraphNodeId: string,
  childRunId: string,
): ExtractedChildLog {
  const prefix = `${subgraphNodeId}/`;
  const out: WorkflowEvent[] = [];
  const sequenceMap = new Map<number, number>();
  let inSession = false;

  for (const event of events) {
    if (!(event.event_type in PLAIN_TYPE)) continue;
    const nodeId = event.node_id ?? '';
    if (nodeId !== subgraphNodeId && !nodeId.startsWith(prefix)) continue;

    if (event.event_type === 'child_workflow_started' && nodeId === subgraphNodeId) {
      inSession = event.internal_payload?.['_child_run_id'] === childRunId;
    }
    if (!inSession) continue;

    const rest = nodeId === subgraphNodeId ? undefined : nodeId.slice(prefix.length);
    const own = event.internal_payload?.['_child_run_id'] === childRunId;
    const sequenceId = out.length;
    sequenceMap.set(event.sequence_id, sequenceId);
    out.push({
      ...event,
      run_id: childRunId,
      sequence_id: sequenceId,
      event_type: own ? PLAIN_TYPE[event.event_type]! : event.event_type,
      ...(rest !== undefined ? { node_id: rest } : { node_id: undefined as never }),
    });
  }

  return { events: out, sequenceMap };
}

/** A read-only event log serving one run's extracted events. */
function staticEventLog(runId: string, events: readonly WorkflowEvent[]): EventLogWriter {
  const forRun = (id: string) => (id === runId ? [...events] : []);
  return {
    async append(_event: NewWorkflowEvent): Promise<void> {
      throw new ForkError('the extracted child log is read-only');
    },
    async loadEvents(id: string): Promise<WorkflowEvent[]> {
      return forRun(id);
    },
    async loadEventsAfter(id: string, after: number): Promise<WorkflowEvent[]> {
      return forRun(id).filter(e => e.sequence_id > after);
    },
    async getLatestSequenceId(id: string): Promise<number> {
      const all = forRun(id);
      return all.length > 0 ? all[all.length - 1].sequence_id : -1;
    },
    async checkpoint(): Promise<void> {
      throw new ForkError('the extracted child log is read-only');
    },
    async loadCheckpoint(): Promise<{ sequence_id: number; state: WorkflowState } | null> {
      return null;
    },
    async compact(): Promise<number> {
      return 0;
    },
  };
}

/** Strip the subgraph namespace from change targets that carry it. */
function toChildScope(changes: readonly Change[], subgraphNodeId: string): Change[] {
  const prefix = `${subgraphNodeId}/`;
  const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  return changes.map(c => {
    if (c.kind === 'model' || c.kind === 'prompt' || c.kind === 'temperature') {
      return { ...c, target: strip(c.target) };
    }
    if (c.kind === 'config' || c.kind === 'output' || c.kind === 'tool') {
      return { ...c, node_id: strip(c.node_id) };
    }
    if (c.kind === 'route') {
      return { ...c, from_node_id: strip(c.from_node_id), to_node_id: strip(c.to_node_id) };
    }
    return c;
  });
}

/**
 * Fork a recorded run at a boundary inside one of its subgraph children.
 *
 * @throws {ForkPointError} If the address is not namespaced, names a
 *   boundary the log does not hold, or reaches deeper than one level.
 * @throws {ForkError} If the parent graph lacks the subgraph node, the
 *   child graph cannot be resolved, or output mapping fails.
 */
export async function forkInChild(
  base: string | ForkableRun,
  options: ChildForkOptions,
): Promise<ChildForkResult> {
  const { runId: parentRunId, options: absorbed } = absorbRecordedRun(base, {
    eventLog: options.eventLog,
    graph: options.graph,
    registry: options.registry,
  });

  const namespaced = options.at.beforeNode;
  const slash = namespaced.indexOf('/');
  if (slash < 0) {
    throw new ForkPointError(
      `forkInChild: '${namespaced}' names no subgraph — an address is 'subgraphNode/childNode'. ` +
      `For a parent boundary, use fork() with { beforeNode: '${namespaced}' }.`,
    );
  }
  const subgraphNodeId = namespaced.slice(0, slash);
  if (namespaced.indexOf('/', slash + 1) >= 0) {
    throw new ForkPointError(
      `forkInChild: '${namespaced}' reaches ${namespaced.split('/').length - 1} levels deep. ` +
      `One level per call — fork the child at '${namespaced.slice(slash + 1)}' from its own extracted log.`,
    );
  }

  const graph = absorbed.graph;
  if (!graph) throw new ForkError(`forkInChild(${parentRunId}): pass the parent 'graph'.`);
  const eventLog = absorbed.eventLog;
  if (!eventLog) throw new ForkError(`forkInChild(${parentRunId}): pass the parent 'eventLog'.`);
  if (!options.loadGraph) {
    throw new ForkError(`forkInChild(${parentRunId}): pass 'loadGraph' to resolve the child graph.`);
  }

  const subNode = graph.nodes.find(n => n.id === subgraphNodeId);
  if (!subNode?.subgraph_config) {
    throw new ForkError(
      `forkInChild(${parentRunId}): '${subgraphNodeId}' is not a subgraph node of this graph.`,
    );
  }
  const childGraph = await options.loadGraph(subNode.subgraph_config.subgraph_id);
  if (!childGraph) {
    throw new ForkError(
      `forkInChild(${parentRunId}): child graph '${subNode.subgraph_config.subgraph_id}' did not resolve.`,
    );
  }

  const events = await eventLog.loadEvents(parentRunId);

  // The target boundary, selected across the whole parent log the way
  // childForkPoints numbers them, then pinned to its session.
  const boundaries = childForkPoints(events).filter(p => p.nodeId === namespaced);
  if (boundaries.length === 0) {
    const available = [...new Set(childForkPoints(events).map(p => p.nodeId))];
    throw new ForkPointError(
      `forkInChild: '${namespaced}' never executed in this run's children. ` +
      `Recorded child boundaries: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
    );
  }
  const occurrence = options.at.occurrence;
  const target = occurrence === 'last'
    ? boundaries[boundaries.length - 1]
    : boundaries[(occurrence ?? 1) - 1];
  if (!target) {
    throw new ForkPointError(
      `forkInChild: '${namespaced}' executed ${boundaries.length} time(s), so occurrence ` +
      `${String(occurrence)} does not exist.`,
    );
  }
  if (!target.childRunId) {
    throw new ForkPointError(
      `forkInChild: the boundary at sequence ${target.sequenceId} carries no child run id, ` +
      `so its session cannot be isolated.`,
    );
  }

  const extracted = extractChildLog(events, subgraphNodeId, target.childRunId);
  const childForkSequence = extracted.sequenceMap.get(target.sequenceId);
  if (childForkSequence === undefined) {
    throw new ForkError(
      `forkInChild: boundary at parent sequence ${target.sequenceId} fell outside its own ` +
      `extracted session — the log is inconsistent.`,
    );
  }

  const rawChanges = options.change === undefined
    ? []
    : (Array.isArray(options.change) ? options.change : [options.change]).map(c => ChangeSchema.parse(c));
  const childChanges = toChildScope(rawChanges, subgraphNodeId);

  logger.info('fork_in_child', {
    parent_run_id: parentRunId,
    subgraph_node_id: subgraphNodeId,
    child_run_id: target.childRunId,
    child_sequence: childForkSequence,
    changes: childChanges.length,
  });

  const child = await fork(target.childRunId, {
    at: { sequence: childForkSequence },
    ...(options.childVariantRunId ? { runId: options.childVariantRunId } : {}),
    ...(childChanges.length > 0 ? { change: childChanges } : {}),
    eventLog: staticEventLog(target.childRunId, extracted.events),
    graph: childGraph,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.ignoreBudget !== undefined ? { ignoreBudget: options.ignoreBudget } : {}),
  });

  if (options.continueParent === false) {
    return { subgraphNodeId, childBaseRunId: target.childRunId, child };
  }
  if (!child.state || child.state.status !== 'completed') {
    return {
      subgraphNodeId,
      childBaseRunId: target.childRunId,
      child,
      parentSkipped: `the child variant ${child.state?.status ?? 'produced no state'}, so there is no output to carry into the parent tail`,
    };
  }

  const fail: BoundaryFailure = (direction, key, detail) => {
    throw new ForkError(
      `forkInChild: mapping the child variant's output ${direction} failed at '${key}': ${detail}`,
    );
  };
  const outputs = mapOutbound(
    child.state.memory,
    child.state.taint_registry ?? {},
    subNode.subgraph_config.output_mapping,
    childGraph.outputs,
    fail,
  );

  // Which execution of the subgraph node held this session: the last one
  // that started before the target boundary.
  const parentPoint = forkPoints(events)
    .filter(p => p.nodeId === subgraphNodeId && p.sequenceId < target.sequenceId)
    .pop();
  if (!parentPoint) {
    throw new ForkError(
      `forkInChild: no '${subgraphNodeId}' execution encloses sequence ${target.sequenceId}.`,
    );
  }

  const parent = await fork(parentRunId, {
    at: { beforeNode: subgraphNodeId, occurrence: parentPoint.occurrence },
    ...(options.runId ? { runId: options.runId } : {}),
    change: [{ kind: 'output', node_id: subgraphNodeId, memory: outputs }],
    eventLog,
    graph,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
    ...((options.parentPolicy ?? options.policy)
      ? { policy: options.parentPolicy ?? options.policy }
      : {}),
    ...(options.hitl ? { hitl: options.hitl } : {}),
    ...(options.ignoreBudget !== undefined ? { ignoreBudget: options.ignoreBudget } : {}),
  });

  return { subgraphNodeId, childBaseRunId: target.childRunId, child, parent };
}
