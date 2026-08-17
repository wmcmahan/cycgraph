/**
 * fork() — run a recorded run again, differently
 *
 * Replays a base run's log up to a fork point, applies declarative changes,
 * and executes the remaining tail live. The prefix costs nothing: the stored
 * actions already carry the agent outputs, so only what the change could
 * affect is actually re-run.
 *
 * **Two engine details this has to get right**, both of which look like
 * nothing and fail loudly later:
 *
 * 1. The variant starts its log with a `workflow_started` at sequence 0 and a
 *    checkpoint anchored to it. `IdempotencyTracker.rebuildFromEventLog`
 *    reports no usable sequence for a checkpoint at 0, so the runner keeps
 *    whatever it was given — which means the fork must hand it
 *    `nextSequenceId: 1` through `_rehydrate`. A runner built straight from
 *    the constructor would start at 0, collide with its own genesis event, and
 *    latch that as a fatal split-brain error.
 * 2. The replayed prefix carries the BASE run's `_last_event_sequence_id`. Left
 *    alone it becomes a high-water mark from another log, and a later
 *    crash-resume of the variant can use it to decide a node already ran when
 *    it never did. It is reset to the variant's own genesis.
 *
 * @module replay/fork
 */

import { v4 as uuidv4 } from 'uuid';
import type { Graph } from '../graph/graph.js';
import type { WorkflowState } from '../state/state.js';
import { hydrateWorkflowState } from '../state/state.js';
import { REPLAY_VERSION } from '../state/reducers.js';
import type { EventLogWriter } from '../persistence/event-log.js';
import { InMemoryEventLogWriter } from '../persistence/event-log.js';
import type { AgentRegistry, PersistenceProvider } from '../persistence/interfaces.js';
import type { WorkflowEvent } from '../persistence/event.js';
import { GraphRunner, type GraphRunnerOptions, type HumanResponse } from '../execution/engine/graph-runner.js';
import { createLogger } from '../observability/logger.js';
import { getTracer, withSpan } from '../observability/tracing.js';
import { replayEvents } from './replay-events.js';
import { planForkPoint, ForkPointError, type ForkPoint } from './fork-point.js';
import { resolveForkSource, snapshotPoints, loadSnapshotState, type ForkSourceKind } from './fork-source.js';
import { ChangeSchema, detectConflicts, describeChange, type Change } from './mutations.js';
import { applyOverlays } from './overlay.js';
import { ForkError, ReplayVersionMismatchError } from './errors.js';
import { createForkGuard, type SideEffectPolicy, type SuppressedEffect } from './fork-guard.js';
import { diffRuns, formatRunDiff, type RunDiff } from './diff.js';
import { estimateTailCost, formatEstimate, type TailEstimate } from './estimate.js';
import { createChangeMiddleware, hasExecutionTimeChanges } from './change-middleware.js';
import { indexBaseRun, createMemoizer, type MemoHit } from './memoize.js';

const logger = createLogger('replay.fork');

/** The resolved fork point, handed to a `change` callback. */
export interface ForkContext {
  /** Node the tail will execute first. */
  node?: string;
  /** Sequence the variant begins diverging at. */
  sequence: number;
  /** `iteration_count` the tail starts from. */
  iteration: number;
  /** How the address resolved, for reports. */
  description: string;
}

/** One change, several, or a function of the resolved fork point. */
export type ChangeInput =
  | Change
  | Change[]
  | ((at: ForkContext) => Change | Change[]);

/**
 * A recorded run, accepted in place of a run id.
 *
 * Structurally what `runRecorded()` returns, so a fork can be spelled
 * `fork(base, { … })` instead of restating the run id, the log, the provider,
 * and the registry that the recorder already handed back. Getting one of those
 * four wrong is the most common way a fork fails, and the registry in
 * particular exists nowhere else: `graph()` builds it per run from inline
 * `agent()` definitions.
 */
export interface ForkableRun {
  runId: string;
  eventLog?: EventLogWriter;
  persistence?: PersistenceProvider;
  registry?: AgentRegistry;
}

/** Options for {@link fork}. */
export interface ForkOptions {
  /** Where to diverge. Defaults to `'failure'` on a failed base run. */
  at?: ForkPoint;
  /** What to do differently. */
  change?: ChangeInput;
  /** The base run's event log. Optional only for a snapshot fork. */
  eventLog?: EventLogWriter;
  /**
   * Which substrate to read the starting state from. `'auto'` (the default)
   * prefers events and falls back to snapshots when the log was compacted away.
   */
  source?: ForkSourceKind | 'auto';
  /** The graph the base run executed. Resolved through `persistence` when absent. */
  graph?: Graph;
  /**
   * Resolves the graph from the base run's row, and receives the variant's
   * run row, lineage, and state snapshots. Omit for an ephemeral fork.
   */
  persistence?: PersistenceProvider;
  /** Groups this variant with the rest of a sweep. */
  forkGroupId?: string;
  /** Where the tail's agents come from. */
  registry?: AgentRegistry;
  /**
   * Log the variant records into.
   *
   * Defaults to the base run's log when `persistence` is supplied — a
   * persisted fork's events must outlive the process, or the row survives a
   * crash while the history needed to recover it does not. Ephemeral forks
   * default to a fresh in-memory log.
   */
  variantEventLog?: EventLogWriter;
  policy?: {
    /** Side-effect handling for the tail. Defaults to `'replay'`. */
    sideEffects?: SideEffectPolicy;
    /**
     * Serve tail nodes their recorded output when their inputs are unchanged.
     *
     * Off by default: a fork's promise is that its tail runs live. Turning it
     * on removes resampling noise from the comparison and makes sweeps
     * affordable, at the cost of some tail nodes not actually running.
     */
    memoize?: boolean;
  };
  /** Extra runner options for the tail. */
  runner?: Omit<GraphRunnerOptions, 'eventLog' | 'registry'>;
  /**
   * Answer approval gates as they arise, rather than with one fixed decision.
   *
   * `change.humanResponse` states a single answer up front, which is a change
   * to the run and is recorded as one. This is the other case: the base run
   * had a reviewer, scripted or otherwise, and the fork needs the same
   * behaviour to be comparable at all. Not a change, so it is not recorded as
   * one — it is part of the run's environment.
   */
  hitl?: (question: string) => Promise<HumanResponse>;
  /**
   * Id for the variant run. Generated when absent.
   *
   * Supplied by callers that must open something keyed on the run — an
   * artifact recorder, a log sink — before the tail starts producing into it.
   */
  runId?: string;
  /**
   * Trace the base run was recorded under, so the fork's span can point at it.
   *
   * A fork gets its own trace. Without this the two are unrelated in a trace
   * viewer, and nothing on screen says which one was the counterfactual.
   */
  baseTraceId?: string;
  /** Resolve and report without executing anything. */
  dryRun?: boolean;
  /**
   * Proceed even when the inherited budget cannot cover the estimated tail.
   * The tail may still stop on `BudgetExceededError` partway through.
   */
  ignoreBudget?: boolean;
}

/** What a fork produced. */
export interface ForkResult {
  /** The variant's run id. */
  runId: string;
  /** The run it forked. */
  baseRunId: string;
  /** Sequence the variant began diverging at. */
  forkSequenceId: number;
  /** Node the tail started with. */
  forkNodeId?: string;
  /** Reconstructed prefix state, before changes were applied. */
  prefixState: WorkflowState;
  /** The base run's final state. */
  baseState: WorkflowState;
  /** The variant's final state. `null` for a dry run. */
  state: WorkflowState | null;
  /** Changes as applied, in wire form. */
  changes: Change[];
  /** Side effects the guard held back. */
  suppressedEffects: SuppressedEffect[];
  /** Tail nodes served from the recording because their inputs were unchanged. */
  memoHits: MemoHit[];
  /** The variant's log. */
  eventLog: EventLogWriter;
  /** Cost the tail actually incurred, over what the prefix already held. */
  incurredCostUsd: number;
  /** Comparison against the base run. `null` for a dry run. */
  diff: RunDiff | null;
  /** What the tail was predicted to cost, before it ran. */
  estimate: TailEstimate;
  /** A human-readable summary. */
  explain(): string;
}

/**
 * Fold a recorded run's handles into the options.
 *
 * Explicit options win, so a caller can pass the recorded run for convenience
 * and still redirect one piece of it — a different variant log, say.
 */
export function absorbRecordedRun(
  base: string | ForkableRun,
  options: ForkOptions,
): { runId: string; options: ForkOptions } {
  if (typeof base === 'string') return { runId: base, options };
  return {
    runId: base.runId,
    options: {
      ...options,
      eventLog: options.eventLog ?? base.eventLog,
      persistence: options.persistence ?? base.persistence,
      registry: options.registry ?? base.registry,
    },
  };
}

/** Normalize `change` into a validated, conflict-checked list. */
function resolveChanges(input: ChangeInput | undefined, at: ForkContext): Change[] {
  if (!input) return [];
  const raw = typeof input === 'function' ? input(at) : input;
  const list = Array.isArray(raw) ? raw : [raw];
  const changes = list.map(c => ChangeSchema.parse(c));

  const conflicts = detectConflicts(changes);
  if (conflicts.length > 0) {
    throw new ForkError(`Conflicting changes:\n  ${conflicts.join('\n  ')}`);
  }
  return changes;
}

/** Load the base run's graph, from the option or the run row. */
async function resolveGraph(
  baseRunId: string,
  options: ForkOptions,
): Promise<Graph> {
  if (options.graph) return options.graph;
  if (!options.persistence) {
    throw new ForkError(
      `fork(${baseRunId}): pass either a 'graph' or a 'persistence' provider to resolve one from the run row.`,
    );
  }
  const row = await options.persistence.loadWorkflowRun(baseRunId);
  if (!row) {
    throw new ForkError(`fork(${baseRunId}): no such run in this persistence provider.`);
  }
  const graph = await options.persistence.loadGraph(row.graph_id);
  if (!graph) {
    throw new ForkError(
      `fork(${baseRunId}): run references graph '${row.graph_id}', which is not saved. ` +
      `A run recorded without saveGraph() cannot be forked by run id — pass 'graph' explicitly.`,
    );
  }
  return graph;
}

/** Apply memory changes to the reconstructed prefix. */
function patchMemory(state: WorkflowState, changes: readonly Change[]): WorkflowState {
  const memory = { ...state.memory };
  for (const c of changes) {
    if (c.kind !== 'memory') continue;
    for (const [key, value] of Object.entries(c.set ?? {})) memory[key] = value;
    for (const key of c.delete ?? []) delete memory[key];
  }
  return memory === state.memory ? state : { ...state, memory };
}

/**
 * Re-key the prefix state onto the variant's own identity.
 *
 * `_last_event_sequence_id` is dropped rather than carried: it is the base
 * log's high-water mark, and the variant's log starts over at zero.
 */
function rekey(state: WorkflowState, runId: string): WorkflowState {
  const { _last_event_sequence_id: _dropped, ...rest } = state;
  return { ...rest, run_id: runId } as WorkflowState;
}

/**
 * Fork a recorded run.
 *
 * @param baseRunId The run to fork.
 * @param options   Where to diverge, what to change, and the backends to use.
 *
 * @throws {ForkError} If the run cannot be located, has no recorded events, or
 *   the changes conflict.
 * @throws {ForkPointError} If the address does not resolve to a node boundary.
 * @throws {ReplayVersionMismatchError} If the log was written under different
 *   reducer semantics, which would make the two states incomparable.
 */
export async function fork(
  base: string | ForkableRun,
  options: ForkOptions,
): Promise<ForkResult> {
  const { runId: baseRunId, options: resolved } = absorbRecordedRun(base, options);
  options = resolved;

  const graph = await resolveGraph(baseRunId, options);

  // The base run's final state is one side of the comparison, and its cost
  // totals are what "what the tail added" is measured against.
  const source = await resolveForkSource(baseRunId, {
    kind: options.source,
    eventLog: options.eventLog,
    persistence: options.persistence,
    replayBase: (events) => replayEvents(events, seedState(graph, baseRunId, events), {
      onVersionMismatch: (logged, current) => {
        throw new ReplayVersionMismatchError(baseRunId, logged, current);
      },
    }).state,
  });
  const { events, baseState } = source;

  const point = options.at ?? (baseState.status === 'failed' && source.kind === 'events'
    ? 'failure'
    : undefined);
  if (!point) {
    throw new ForkError(
      `fork(${baseRunId}): this run ${baseState.status}, so there is no obvious fork point. ` +
      `Pass 'at' — forkPoints() lists what is addressable.`,
    );
  }

  const { prefixState, forkSequenceId, forkNodeId, description, reExecutesCurrentNode } =
    source.kind === 'snapshot'
      ? await resolveSnapshotPrefix(baseRunId, point, options)
      : resolveEventPrefix(graph, baseRunId, events, point);

  const at: ForkContext = {
    node: forkNodeId,
    sequence: forkSequenceId,
    iteration: prefixState.iteration_count,
    // A snapshot fork cannot know whether its node already ran, so say what
    // the tail will do rather than implying a precision the source lacks.
    description: reExecutesCurrentNode
      ? `${description}, re-running '${forkNodeId}'`
      : description,
  };
  const changes = resolveChanges(options.change, at);

  const runId = options.runId ?? uuidv4();
  const forkedState = hydrateWorkflowState(patchMemory(rekey(prefixState, runId), changes));

  // A fork inherits the prefix's spend, so forking a nearly-exhausted run
  // produces a tail that dies on its first node. That is faithful and it reads
  // as a bug, so it is refused up front with the numbers that explain it.
  const estimate = estimateTailCost(baseState, prefixState);
  if (estimate.exceedsBudget && !options.ignoreBudget) {
    throw new ForkError(
      `fork(${baseRunId}) refused: the base run had $${estimate.headroomUsd!.toFixed(4)} of its ` +
      `$${prefixState.budget_usd!.toFixed(2)} budget left at ${at.description}, and the tail needs ` +
      `about $${estimate.costUsd.toFixed(4)} based on what ${estimate.nodes.join(', ')} cost in the ` +
      `base run. Raise budget_usd on the fork, fork earlier, or pass ignoreBudget to proceed anyway.`,
    );
  }

  const overlays = await applyOverlays(graph, options.registry ?? emptyRegistry(), changes);

  // A persisted fork defaults its events into the base run's log writer, so
  // the variant's durability matches its row: crash recovery and forking the
  // fork both need the events to outlive this process. An ephemeral fork keeps
  // a fresh in-memory log, since there is no row for a durable writer's
  // foreign key to hang the events on.
  const variantEventLog = options.variantEventLog
    ?? (options.persistence ? options.eventLog : undefined)
    ?? new InMemoryEventLogWriter();

  const result = (
    state: WorkflowState | null,
    suppressed: SuppressedEffect[],
    memoHits: MemoHit[],
  ): ForkResult => {
    const diff = state
      ? diffRuns(baseState, state, { prefixState, suppressedEffects: suppressed })
      : null;
    return {
      runId,
      baseRunId,
      forkSequenceId,
      forkNodeId,
      prefixState,
      baseState,
      state,
      changes,
      suppressedEffects: suppressed,
      memoHits,
      eventLog: variantEventLog,
      incurredCostUsd: diff?.cost.incurredUsd ?? 0,
      diff,
      estimate,
      explain: () => explain({ runId, baseRunId, at, changes, diff, estimate }),
    };
  };

  if (options.dryRun) return result(null, [], []);

  // The run row FIRST: a relational event log keys every append to it, so the
  // genesis write below would otherwise die on a foreign key. Lineage lands
  // with it, so a fork that crashes mid-tail is still identifiable as a fork.
  if (options.persistence) {
    await options.persistence.saveWorkflowRun(forkedState);
    await options.persistence.saveRunLineage?.(runId, {
      kind: 'counterfactual',
      parent_run_id: baseRunId,
      fork_sequence_id: forkSequenceId,
      fork_mutations: changes,
      ...(options.forkGroupId ? { fork_group_id: options.forkGroupId } : {}),
    });
  }

  // Genesis: the variant's log opens with its own `workflow_started`, and a
  // checkpoint anchored to it holds the forked state. Recovery of the variant
  // then works through the ordinary checkpoint path without ever reading the
  // base run's log.
  await variantEventLog.append({
    run_id: runId,
    sequence_id: 0,
    event_type: 'workflow_started',
    internal_payload: {
      replay_version: REPLAY_VERSION,
      forked_from: baseRunId,
      fork_sequence_id: forkSequenceId,
      fork_mutations: changes,
      config: {
        goal: forkedState.goal,
        constraints: forkedState.constraints,
        max_iterations: forkedState.max_iterations,
        max_retries: forkedState.max_retries,
        max_execution_time_ms: forkedState.max_execution_time_ms,
        ...(forkedState.max_token_budget !== undefined
          ? { max_token_budget: forkedState.max_token_budget } : {}),
        ...(forkedState.budget_usd !== undefined ? { budget_usd: forkedState.budget_usd } : {}),
      },
    },
  });
  await variantEventLog.checkpoint(runId, 0, forkedState);

  // Execution-time changes go BEFORE the guard: an explicitly substituted tool
  // result is the caller overriding the node, so the guard should never see
  // that node and never block it.
  const changeMw = hasExecutionTimeChanges(changes) ? createChangeMiddleware(changes) : undefined;

  const guard = createForkGuard({
    events,
    policy: options.policy?.sideEffects ?? 'replay',
    graph: overlays.graph,
  });

  // Memoization sits after the explicit changes and before the guard: an
  // overridden node is never a candidate, and a memo hit means the node did
  // not touch the world, so the guard has nothing left to protect.
  const memoizer = options.policy?.memoize
    ? createMemoizer({
      index: await indexBaseRun(graph, events, seedState(graph, baseRunId, events), options.registry ?? emptyRegistry()),
      graph: overlays.graph,
      registry: overlays.registry,
    })
    : undefined;

  // Preflight rejects custom tool sources with no registration, and it runs
  // before the guard can short-circuit anything — so a fork of any graph with
  // a tool node would otherwise demand the very tools it exists to not call.
  const providedTools = options.runner?.tools ?? [];
  const providedNames = new Set(
    providedTools.flatMap(t => (typeof t === 'object' && t !== null && 'name' in t ? [String(t.name)] : [])),
  );
  const tools = [...providedTools, ...guard.toolStubs(providedNames)];

  const runner = new GraphRunner(overlays.graph, forkedState, {
    ...options.runner,
    registry: overlays.registry,
    eventLog: variantEventLog,
    ...(tools.length > 0 ? { tools } : {}),
    runKind: 'counterfactual',
    ...(options.persistence && !options.runner?.persistState
      ? { persistState: (s: WorkflowState) => options.persistence!.saveWorkflowSnapshot(s) }
      : {}),
    middleware: [
      ...(options.runner?.middleware ?? []),
      ...(changeMw ? [changeMw.middleware] : []),
      ...(memoizer ? [memoizer.middleware] : []),
      guard.middleware,
    ],
    ...(options.runner?.memoryWriter ? { memoryWriter: guard.wrapMemoryWriter(options.runner.memoryWriter) } : {}),
    // Compaction would delete the genesis anchor a variant recovers from.
    compactionInterval: options.runner?.compactionInterval ?? 0,
  });

  // Genesis sits at sequence 0, so the first live append must be 1. See the
  // module note: the constructor alone would start at 0 and collide.
  runner._rehydrate({ state: forkedState, executedActionIds: [], nextSequenceId: 1 });

  logger.info('fork_started', {
    run_id: runId,
    base_run_id: baseRunId,
    fork_sequence_id: forkSequenceId,
    fork_node_id: forkNodeId,
    changes: changes.length,
  });

  // A span of its own, so a fork is identifiable in a trace viewer rather than
  // appearing as an unexplained second run of the same graph. The runner's own
  // `workflow.run` span nests under it.
  let state: WorkflowState;
  try {
    state = await withSpan(getTracer('orchestrator.replay'), 'replay.fork', async (span) => {
      span.setAttribute('fork.run_id', runId);
      span.setAttribute('fork.base_run_id', baseRunId);
      span.setAttribute('fork.sequence_id', forkSequenceId);
      span.setAttribute('fork.changes', changes.length);
      if (forkNodeId) span.setAttribute('fork.node_id', forkNodeId);
      if (options.baseTraceId) span.setAttribute('fork.base_trace_id', options.baseTraceId);
      return runAnsweringGates(runner, changes, baseRunId, options.hitl);
    });
  } catch (error) {
    // A tail that throws — budget breach, timeout, a blocked side effect —
    // must not leave the persisted row claiming the fork is still running.
    // Nothing will ever come back for it.
    if (options.persistence) {
      await options.persistence.updateRunStatus(runId, 'failed').catch(() => {
        // The status update is best-effort cleanup on an already-failing path.
      });
    }
    throw error;
  }
  return result(state, guard.suppressed, memoizer?.hits ?? []);
}

/** How many gates one fork will answer before it gives up. */
const MAX_ANSWERED_GATES = 20;

/**
 * Run the tail, answering approval gates rather than stopping at them.
 *
 * Without a `human_response` change a gate leaves the run `waiting`, which is
 * the correct outcome and what the diff will show. With one, the fork answers
 * and resumes through the runner's ordinary HITL path, so the decision is
 * recorded in the variant's log exactly as a reviewer's would be.
 *
 * The cap is a loop guard, not a policy: a graph that gates in a cycle would
 * otherwise answer forever.
 */
async function runAnsweringGates(
  runner: GraphRunner,
  changes: readonly Change[],
  baseRunId: string,
  hitl?: (question: string) => Promise<HumanResponse>,
): Promise<WorkflowState> {
  const answer = changes.find(c => c.kind === 'human_response');
  let state = await runner.run();
  if (!answer && !hitl) return state;

  for (let answered = 0; state.status === 'waiting'; answered++) {
    if (answered >= MAX_ANSWERED_GATES) {
      logger.warn('fork_gate_limit_reached', {
        base_run_id: baseRunId,
        run_id: state.run_id,
        answered,
      });
      return state;
    }
    // A declared answer wins over the environment's reviewer: it is the
    // caller stating the counterfactual, which is the whole point of the fork.
    runner.applyHumanResponse(answer
      ? {
        decision: answer.decision,
        ...(answer.data !== undefined ? { data: answer.data } : {}),
        ...(answer.memory_updates ? { memory_updates: answer.memory_updates } : {}),
      }
      : await hitl!(String(state.waiting_for ?? 'approval')));
    state = await runner.run();
  }

  return state;
}

/** A resolved starting point, however it was reached. */
interface ResolvedPrefix {
  prefixState: WorkflowState;
  forkSequenceId: number;
  forkNodeId?: string;
  description: string;
  /** Whether the tail re-runs a node whose output is already in the state. */
  reExecutesCurrentNode: boolean;
}

/** Replay the log up to an addressed node boundary. */
function resolveEventPrefix(
  graph: Graph,
  baseRunId: string,
  events: readonly WorkflowEvent[],
  point: ForkPoint,
): ResolvedPrefix {
  const plan = planForkPoint(events, point);
  const prefix = replayEvents(events, seedState(graph, baseRunId, events), {
    stopBefore: plan.kind === 'predicate'
      ? plan.stopBefore
      : ({ event }) => event.sequence_id >= plan.sequenceId,
  });

  // A predicate is the one address that cannot be boundary-checked before the
  // replay, so it is checked after: every structural form is validated to land
  // on a node boundary, and the escape hatch must not be an escape from that.
  // Mid-group, the state holds an action whose usage accounting has not landed
  // — a state the run never persisted.
  if (plan.kind === 'predicate' && prefix.stoppedAt && prefix.stoppedAt.event_type !== 'node_started') {
    throw new ForkPointError(
      `The 'where' predicate halted on a '${prefix.stoppedAt.event_type}' event ` +
      `(sequence ${prefix.stoppedAt.sequence_id}), which is inside a node's execution. ` +
      `A fork must start where no node is mid-execution — match a 'node_started' event instead.`,
    );
  }

  return {
    prefixState: prefix.state,
    forkSequenceId: prefix.stoppedAt?.sequence_id ?? (prefix.lastAppliedSequenceId ?? -1) + 1,
    forkNodeId: plan.kind === 'sequence' ? plan.nodeId : prefix.stoppedAt?.node_id,
    description: plan.description,
    reExecutesCurrentNode: false,
  };
}

/**
 * Read a persisted snapshot as the starting point.
 *
 * Only `{ version }` addresses a snapshot. Everything else — `beforeNode`,
 * `failure`, iteration boundaries — needs the log to locate, and answering
 * them from snapshots alone would mean guessing at boundaries this substrate
 * cannot see. See the module note on `fork-source.ts`.
 */
async function resolveSnapshotPrefix(
  baseRunId: string,
  point: ForkPoint,
  options: ForkOptions,
): Promise<ResolvedPrefix> {
  if (typeof point === 'string' || !('version' in point)) {
    const listed = await snapshotPoints(baseRunId, options.persistence!);
    const range = listed.length > 0
      ? `Versions ${listed[0].version}..${listed[listed.length - 1].version} are addressable.`
      : 'This run has no snapshots.';
    throw new ForkError(
      `fork(${baseRunId}): a snapshot fork can only be addressed by { version }, because node ` +
      `and iteration boundaries are only visible in the event log. ${range}`,
    );
  }

  const state = await loadSnapshotState(baseRunId, point.version, options.persistence!);
  return {
    prefixState: state,
    forkSequenceId: state._last_event_sequence_id ?? -1,
    forkNodeId: state.current_node,
    description: `snapshot version ${point.version}`,
    reExecutesCurrentNode: state.current_node !== undefined,
  };
}

/** Minimal registry for forks whose changes need no agent lookups. */
function emptyRegistry(): AgentRegistry {
  return {
    loadAgent: async () => null,
    register: () => {
      throw new ForkError('fork(): no registry was provided, so agents cannot be registered.');
    },
  };
}

/** The pending state a base-run replay folds onto. */
function seedState(graph: Graph, runId: string, events: readonly WorkflowEvent[]): WorkflowState {
  const started = events.find(e => e.event_type === 'workflow_started');
  const config = (started?.internal_payload?.config ?? {}) as Partial<WorkflowState>;
  return hydrateWorkflowState({
    state_schema_version: 2,
    workflow_id: graph.id,
    run_id: runId,
    status: 'pending',
    goal: config.goal ?? '',
    constraints: config.constraints ?? [],
    // Seeded input memory: no action wrote it, so replay cannot derive it.
    memory: config.memory ?? {},
    max_retries: config.max_retries ?? 3,
    max_iterations: config.max_iterations ?? 50,
    max_execution_time_ms: config.max_execution_time_ms ?? 3600000,
    ...(config.max_token_budget !== undefined ? { max_token_budget: config.max_token_budget } : {}),
    ...(config.budget_usd !== undefined ? { budget_usd: config.budget_usd } : {}),
    created_at: events[0].created_at,
    updated_at: events[0].created_at,
  });
}

/** Render the fork as the block a developer reads. */
function explain(input: {
  runId: string;
  baseRunId: string;
  at: ForkContext;
  changes: readonly Change[];
  diff: RunDiff | null;
  estimate: TailEstimate;
}): string {
  const short = (id: string): string => `${id.slice(0, 6)}…`;
  const header =
    `fork ${short(input.runId)} of ${short(input.baseRunId)} at seq ${input.at.sequence} ` +
    `(${input.at.description}, iteration ${input.at.iteration})`;

  const changes = input.changes.map(c => `  change    ${describeChange(c)}`);

  if (!input.diff) {
    return [
      header,
      ...changes,
      `  estimate  ${formatEstimate(input.estimate)}`,
      '  dry run   nothing executed',
    ].join('\n');
  }

  return [header, ...changes, formatRunDiff(input.diff)].join('\n');
}
