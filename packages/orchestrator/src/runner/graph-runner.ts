/**
 * Graph Runner
 *
 * Core execution engine for the orchestrator. Validates graph
 * structure, executes nodes in topological order with retry /
 * circuit-breaker logic, persists state after every step for
 * resumability, and emits events for observability.
 *
 * @module runner/graph-runner
 */

import { EventEmitter } from 'events';
import type { Graph, GraphNode, GraphEdge } from '../types/graph.js';
import type { WorkflowState, Action, StateView } from '../types/state.js';
import { rootReducer, internalReducer, validateAction, REPLAY_VERSION } from '../reducers/index.js';
import { calculateBackoff, sleep } from './helpers.js';
import { evaluateCondition } from './conditions.js';
import { getNextNode, getCurrentNode, shouldContinue, buildEdgeMap } from './router.js';
import { IdempotencyTracker } from './idempotency-tracker.js';
import { buildExecutorContext as buildExecutorContextFn, type ExecutorContextRunner } from './executor-context-builder.js';
import { StreamChannel } from './stream-channel.js';
import { BudgetMonitor } from './budget-monitor.js';
import { PersistenceCoordinator } from './persistence-coordinator.js';
import { validateGraph } from '../validation/graph-validator.js';
import { ActionSchema } from '../types/state.js';
import { createLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/context.js';
import { calculateCost } from '../utils/pricing.js';
import { BudgetExceededError, WorkflowTimeoutError, NodeConfigError, CircuitBreakerOpenError, UnsupportedNodeTypeError, NodeBudgetExceededError, NoMatchingEdgeError } from './errors.js';
import {
  incrementWorkflowsStarted,
  incrementWorkflowsCompleted,
  incrementWorkflowsFailed,
  recordWorkflowDuration,
  recordTokensUsed,
  recordCostUsd,
} from '../utils/metrics.js';
import type { EventLogWriter } from '../db/event-log.js';
import { NoopEventLogWriter, EventSequenceConflictError } from '../db/event-log.js';
import { StaleClaimError } from '../persistence/errors.js';
import type { EventType } from '../types/event.js';
import type { StreamEvent } from './stream-events.js';
import { computeMemoryDiff } from './memory-differ.js';
import { StateDeltaTracker, type StatePatch } from '../persistence/delta-tracker.js';

// Re-export error classes for backward compatibility
export { BudgetExceededError, WorkflowTimeoutError };
import { getTracer, withSpan } from '../utils/tracing.js';
import { v4 as uuidv4 } from 'uuid';
import type { GraphRunnerMiddleware, MiddlewareContext } from './middleware.js';

// External runtime types — kept for the runner's public option types
import type { ToolResolver } from '../mcp/connection-manager.js';
import type { ModelResolver } from '../agent/model-resolver.js';
import type { ContextCompressor } from '../agent/context-compressor.js';
import type { MemoryRetriever } from '../agent/memory-retriever.js';
import type { MemoryWriter } from '../agent/memory-writer.js';
import type { FactSanitizer } from '../agent/fact-sanitizer.js';
import type { FitnessFunction } from '../agent/fitness-function.js';
import type { RateLimiter } from '../agent/rate-limiter.js';
import { PermissionDeniedError } from '../agent/agent-executor/errors.js';

// Extracted modules
import { CircuitBreakerManager } from './circuit-breaker.js';
import { createStateView } from './state-view.js';
import type { NodeExecutorContext } from './node-executors/context.js';
import { getNodeExecutor } from './node-executors/index.js';

const logger = createLogger('runner.graph');
const tracer = getTracer('orchestrator.runner');

/** Events emitted by {@link GraphRunner} for observability. */
export interface GraphRunnerEvents {
  /** Emitted when the workflow begins execution. */
  'workflow:start': { workflow_id: string; run_id: string };
  /** Emitted on successful completion. */
  'workflow:complete': { workflow_id: string; run_id: string; duration_ms: number };
  /** Emitted on unrecoverable failure. */
  'workflow:failed': { workflow_id: string; run_id: string; error: string };
  /** Emitted when the workflow exceeds its execution time limit. */
  'workflow:timeout': { workflow_id: string; run_id: string; elapsed_ms: number };
  /** Emitted when the workflow pauses for human input (HITL). */
  'workflow:waiting': { workflow_id: string; run_id: string; waiting_for: string };
  /** Emitted when compensation actions are executed (saga rollback). */
  'workflow:rollback': { workflow_id: string; run_id: string };
  /** Emitted before a node begins execution. */
  'node:start': { node_id: string; type: string; timestamp: number };
  /** Emitted after a node completes successfully. */
  'node:complete': { node_id: string; type: string; duration_ms: number };
  /** Emitted when a node execution fails. */
  'node:failed': { node_id: string; type: string; error: string; attempt: number };
  /** Emitted before a retry attempt. */
  'node:retry': { node_id: string; attempt: number; backoff_ms: number };
  /** Emitted after an action is applied via the reducer. */
  'action:applied': { action_id: string; type: string; node_id: string };
  /** Emitted after state is persisted to storage. */
  'state:persisted': { run_id: string; iteration: number };
  /** Emitted for each token delta during agent streaming. */
  'agent:token_delta': { run_id: string; node_id: string; token: string };
  /** Emitted when a tool call begins executing. */
  'tool:call_start': { run_id: string; node_id: string; tool_name: string; tool_call_id: string; args: unknown; timestamp: number };
  /** Emitted when a tool call finishes executing. */
  'tool:call_finish': { run_id: string; node_id: string; tool_name: string; tool_call_id: string; duration_ms: number; success: boolean; error?: string; timestamp: number };
  /** Emitted when cost crosses a budget threshold (50%, 75%, 90%, 100%). */
  'budget:threshold_reached': {
    run_id: string;
    workflow_id: string;
    threshold_pct: number;
    cost_usd: number;
    budget_usd: number;
  };
  /** Emitted when the workflow is gracefully paused via shutdown(). */
  'workflow:paused': { workflow_id: string; run_id: string };
  /** Emitted when budget-aware model resolution selects a model for an agent. */
  'model:resolved': {
    run_id: string;
    node_id: string;
    agent_id: string;
    reason: string;
    resolved_model: string;
    original_model: string;
    preference: string;
    remaining_budget_usd?: number;
    timestamp: number;
  };
}

/**
 * Default number of events between automatic event-log compactions when an
 * `eventLog` is wired and `compaction_interval` is not specified. Conservative
 * enough that short runs never compact, low enough that a long run's event log
 * stays bounded. Set `compaction_interval: 0` to opt out.
 */
export const DEFAULT_COMPACTION_INTERVAL = 1000;

/**
 * Options for constructing a GraphRunner.
 * Preferred over positional constructor args.
 */
export interface GraphRunnerOptions {
  /** Optional function to persist state snapshots after each step */
  persistStateFn?: (state: WorkflowState) => Promise<void>;
  /** Optional function to load subgraph definitions */
  loadGraphFn?: (graphId: string) => Promise<Graph | null>;
  /** Optional event log writer for durable execution (event sourcing) */
  eventLog?: EventLogWriter;
  /** Token streaming callback — fires for each text delta from agent nodes */
  onToken?: (token: string, nodeId: string) => void;
  /** Middleware hooks for extending runner behavior */
  middleware?: GraphRunnerMiddleware[];
  /**
   * Tool resolver for structured ToolSource declarations.
   * When provided, resolves MCP server tools via `@ai-sdk/mcp` clients.
   * Without it, only built-in tools are resolved.
   * Typically an MCPConnectionManager instance.
   */
  toolResolver?: ToolResolver;
  /**
   * When true, automatically execute compensation actions (saga rollback)
   * before marking the workflow as failed. If rollback succeeds, the
   * workflow transitions to 'cancelled' instead of 'failed'.
   * Defaults to false.
   */
  auto_rollback?: boolean;
  /**
   * When true, a node that is not a declared end node yet has no matching
   * outgoing edge silently completes the workflow (legacy behavior). When
   * false (default), the runner fails with `NoMatchingEdgeError` so a
   * dead-end (e.g. a typo'd edge condition) surfaces instead of producing a
   * misleading "completed" run that only executed part of the graph.
   */
  allow_implicit_completion?: boolean;
  /**
   * Budget-aware model resolver.
   *
   * When provided, agents with `model_preference` will have their
   * concrete model resolved at runtime based on remaining budget.
   * Agents without `model_preference` always use their static `model`.
   */
  modelResolver?: ModelResolver;
  /**
   * Context compression function for memory in prompts.
   *
   * When provided, replaces the default `JSON.stringify` + byte-cap
   * serialization with intelligent compression via `@cycgraph/context-engine`.
   * Without it, memory serialization works exactly as before.
   */
  contextCompressor?: ContextCompressor;
  /**
   * Optional memory retriever for injecting relevant facts into agent prompts.
   *
   * When provided, the runner passes this through to node executors so that
   * prompt builders can retrieve and inject memory context before LLM calls.
   * Follows the same adapter pattern as `contextCompressor`.
   */
  memoryRetriever?: MemoryRetriever;
  /**
   * Optional memory writer for persisting facts produced by `reflection`
   * nodes. Required for reflection nodes to function — without it, the
   * reflection executor throws at runtime.
   *
   * Mirrors `memoryRetriever`: the orchestrator defines the type, the
   * user provides the implementation (typically backed by an
   * `@cycgraph/memory` store).
   */
  memoryWriter?: MemoryWriter;
  /**
   * Optional pre-write hook applied to every fact emitted by reflection
   * nodes before it reaches `memoryWriter`. Use to redact PII, drop
   * policy-violating content, or substitute wording. Returning `null`
   * from the sanitizer drops the fact entirely.
   */
  factSanitizer?: FactSanitizer;
  /**
   * What to do when `factSanitizer` THROWS (not returns null) — e.g. a
   * downed PII service or a buggy regex.
   *
   * - `'drop'` (default): fail closed — drop the fact. The right default
   *   for a safety/redaction control: a transient sanitizer outage must not
   *   silently leak unredacted PII into durable, cross-run memory.
   * - `'pass'`: fail open — write the original (unsanitized) fact. Only use
   *   when reflection availability matters more than redaction guarantees.
   */
  factSanitizerFailMode?: 'drop' | 'pass';
  /**
   * Optional deterministic fitness evaluator for `evolution` nodes. When
   * provided, the evolution executor uses it instead of the LLM-as-judge
   * `evaluator_agent_id`. Use for tasks with verifiable answers — regex,
   * SQL, code, math — where the LLM judge's variance is larger than the
   * discrimination required.
   */
  fitnessFunction?: FitnessFunction;
  /**
   * Optional rate-limiting hook awaited before every LLM call (agent,
   * supervisor, evaluator). Use to pace a workflow inside a provider's
   * request/throughput budget — the implementation may delay (throttle) or
   * throw (hard ceiling). Same injection pattern as the other ports; the engine
   * defines the type, you provide the policy.
   */
  rateLimiter?: RateLimiter;
  /**
   * Number of events between automatic event log compactions.
   *
   * When > 0 (and an `eventLog` is provided), the runner automatically
   * checkpoints and compacts the event log every N events, preventing
   * unbounded event-log growth in long-running workflows. Compaction is
   * recovery-safe: it writes a checkpoint, then deletes only the events behind
   * it (recovery loads the checkpoint + the tail via `loadEventsAfter`).
   *
   * Defaults to {@link DEFAULT_COMPACTION_INTERVAL} so a long run can't grow the
   * event log without bound by default. Set to `0` to disable auto-compaction
   * (e.g. when you retain the full event history for audit and compact manually
   * via `compactEvents()`).
   * @default 1000
   */
  compaction_interval?: number;
  /**
   * Optional callback for persisting state deltas (patches).
   *
   * When provided alongside `persistStateFn`, the runner uses a
   * {@link StateDeltaTracker} to compute diffs between state snapshots.
   * Deltas are sent to this callback; full snapshots go to `persistStateFn`.
   * This reduces I/O for long-running workflows with large memory.
   *
   * If omitted, all persists use `persistStateFn` (full snapshots only).
   */
  persistDeltaFn?: (patch: StatePatch) => Promise<void>;
  /**
   * Options for the delta tracker (snapshot interval, max patch size).
   * Only used when `persistDeltaFn` is provided.
   */
  deltaTrackerOptions?: { full_snapshot_interval?: number; max_patch_bytes?: number };
}

/**
 * Graph execution engine with observability and resilience.
 *
 * @example
 * ```ts
 * const runner = new GraphRunner(graph, initialState, { eventLog });
 * const result = await runner.run();
 * ```
 */
export class GraphRunner extends EventEmitter {
  private graph: Graph;
  private state: WorkflowState;
  private circuitBreakers: CircuitBreakerManager = new CircuitBreakerManager();
  /**
   * Idempotency state. Owned by {@link IdempotencyTracker}; the runner still
   * owns `sequenceId` (single-writer rule — see plan doc).
   */
  private idempotency: IdempotencyTracker = new IdempotencyTracker();
  private startTime?: number;
  private persistStateFn?: (state: WorkflowState) => Promise<void>;
  private loadGraphFn?: (graphId: string) => Promise<Graph | null>;

  // Pre-built lookup maps for O(1) node/edge access (built once in constructor)
  private readonly nodeMap: Map<string, GraphNode>;
  private readonly edgeMap: Map<string, GraphEdge[]>;

  // Event sourcing — durable execution
  private readonly eventLog: EventLogWriter;
  private sequenceId: number = 0;

  // Token streaming callback
  private onToken?: (token: string, nodeId: string) => void;

  // Middleware hooks
  private readonly middleware: GraphRunnerMiddleware[];

  // Tool resolver for structured ToolSource declarations (MCPConnectionManager)
  private readonly toolResolver?: ToolResolver;

  // Auto-rollback on failure (saga compensation)
  private readonly autoRollback: boolean;
  private readonly allowImplicitCompletion: boolean;

  // Budget-aware model resolver (optional)
  private readonly modelResolver?: ModelResolver;

  // Context compressor for memory in prompts (optional)
  private readonly contextCompressor?: ContextCompressor;

  // Memory retriever for injecting relevant facts into prompts (optional)
  private readonly memoryRetriever?: MemoryRetriever;

  // Memory writer for persisting facts from reflection nodes (optional)
  private readonly memoryWriter?: MemoryWriter;

  // Optional pre-write sanitizer applied to reflection facts before persistence
  private readonly factSanitizer?: FactSanitizer;

  // Behavior when factSanitizer throws: 'drop' (fail closed, default) or 'pass'
  private readonly factSanitizerFailMode: 'drop' | 'pass';

  // Optional deterministic fitness evaluator for evolution nodes
  private readonly fitnessFunction?: FitnessFunction;

  // Optional rate-limiting hook awaited before every LLM call
  private readonly rateLimiter?: RateLimiter;

  // Auto-compaction: compact event log every N events (0 = disabled)
  private readonly compactionInterval: number;

  // Differential state persistence
  private readonly persistDeltaFn?: (patch: StatePatch) => Promise<void>;
  private readonly deltaTracker?: StateDeltaTracker;

  // Cancellation — allows external abort of in-flight agent/supervisor calls
  private abortController: AbortController = new AbortController();

  // Graceful shutdown — finish current node, then pause
  private _shuttingDown = false;

  // Streaming — owned by StreamChannel. `isStreaming` stays on the runner
  // because the executor-context-builder reads it via the adapter.
  private isStreaming = false;
  private readonly channel: StreamChannel = new StreamChannel();
  /** Budget threshold tracker. See `runner/budget-monitor.ts`. */
  private readonly budget: BudgetMonitor;
  /** Persistence pipeline + auto-compaction. See `runner/persistence-coordinator.ts`. */
  private readonly persistence: PersistenceCoordinator;
  private lastRunError?: Error;

  /**
   * Create a new GraphRunner.
   *
   * @param graph - The graph definition to execute.
   * @param initialState - The starting workflow state. Resumes from checkpoint
   *   when `state.visited_nodes` is non-empty.
   * @param options - Optional configuration. See {@link GraphRunnerOptions}.
   */
  constructor(
    graph: Graph,
    initialState: WorkflowState,
    options?: GraphRunnerOptions,
  ) {
    super();
    this.graph = graph;
    this.state = initialState;

    this.persistStateFn = options?.persistStateFn;
    this.loadGraphFn = options?.loadGraphFn;
    this.eventLog = options?.eventLog ?? new NoopEventLogWriter();
    this.onToken = options?.onToken;
    this.middleware = options?.middleware ?? [];
    this.toolResolver = options?.toolResolver;
    this.modelResolver = options?.modelResolver;
    this.contextCompressor = options?.contextCompressor;
    this.memoryRetriever = options?.memoryRetriever;
    this.memoryWriter = options?.memoryWriter;
    this.factSanitizer = options?.factSanitizer;
    this.factSanitizerFailMode = options?.factSanitizerFailMode ?? 'drop';
    this.fitnessFunction = options?.fitnessFunction;
    this.rateLimiter = options?.rateLimiter;
    this.autoRollback = options?.auto_rollback ?? false;
    this.allowImplicitCompletion = options?.allow_implicit_completion ?? false;
    this.compactionInterval = options?.compaction_interval ?? DEFAULT_COMPACTION_INTERVAL;
    this.persistDeltaFn = options?.persistDeltaFn;
    if (this.persistDeltaFn) {
      this.deltaTracker = new StateDeltaTracker(options?.deltaTrackerOptions);
    }

    // Build O(1) lookup structures (edgeMap shape owned by router.ts)
    this.nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    this.edgeMap = buildEdgeMap(graph);

    // Wire budget monitor with push-via-callback (preserves yield ordering).
    this.budget = new BudgetMonitor({
      dispatch: (type, payload) => this.dispatchInternal(type, payload),
      push: (event) => this.channel.pushPending(event),
      emit: (event, payload) => this.emit(event, payload),
      isStreaming: () => this.isStreaming,
    });

    // Wire persistence coordinator with the same push-via-callback contract.
    this.persistence = new PersistenceCoordinator({
      persistStateFn: this.persistStateFn,
      persistDeltaFn: this.persistDeltaFn,
      deltaTracker: this.deltaTracker,
      eventLog: this.eventLog,
      compactionInterval: this.compactionInterval,
      isStreaming: () => this.isStreaming,
      push: (event) => this.channel.pushPending(event),
      emit: (event, payload) => this.emit(event, payload),
    });
  }

  /**
   * Cancel a running workflow.
   *
   * Aborts any in-flight LLM calls (agent/supervisor) by signaling the
   * shared AbortController, then transitions the workflow to 'cancelled' status.
   * The main `run()` loop checks the abort signal on each iteration and will
   * exit cleanly after the current node finishes or aborts.
   */
  cancel(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
      this.dispatchInternal('_cancel');
      logger.info('workflow_cancelled', {
        workflow_id: this.state.workflow_id,
        run_id: this.state.run_id,
      });
    }
  }

  /**
   * Request graceful shutdown. The current node will complete,
   * state will be persisted, and the workflow will pause (resumable).
   * Emits 'workflow:paused' when the shutdown is complete.
   */
  shutdown(): void {
    this._shuttingDown = true;
    logger.info('shutdown_requested', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
  }

  /**
   * Dispatch an internal state transition through the internalReducer.
   * Used for runner-controlled lifecycle events (init, fail, complete, etc.).
   * Bypasses permission checks since these are trusted internal operations.
   */
  private dispatchInternal(type: string, payload: Record<string, unknown> = {}): void {
    const action: Action = {
      id: uuidv4(),
      idempotency_key: `_internal:${type}:${Date.now()}`,
      type: type as Action['type'],
      payload,
      metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
    };
    this.state = internalReducer(this.state, action);

    // Fire-and-forget: log internal dispatch to event store
    this.appendEvent('internal_dispatched', { internal_type: type, internal_payload: payload });
  }

  // Consecutive event-log flush failures. Mirrors the snapshot 3-strike
  // rule in PersistenceCoordinator: three consecutive failed flushes halt
  // the workflow instead of silently degrading durable-execution recovery.
  private eventLogFailures: number = 0;

  /** Halt threshold for consecutive event-log flush failures. */
  private static readonly MAX_EVENT_LOG_FAILURES = 3;

  // Append promises issued since the last flush. Appends overlap with node
  // execution (no per-event latency), but persistState() awaits them all
  // BEFORE writing the snapshot so the event log can never silently fall
  // behind the snapshot it anchors.
  private pendingAppends: Array<Promise<{ ok: boolean }>> = [];

  // A fatal append error observed on any append: a sequence conflict or a
  // stale claim both mean another writer is executing this run — fatal for
  // this runner regardless of the consecutive-failure budget.
  private eventLogFatalError: Error | null = null;

  // Events recorded before sequenceId is known to be past the existing log.
  // applyHumanResponse() runs before run() on resume, when a fresh runner
  // still has sequenceId 0 — appending immediately would collide with the
  // run's existing events. Deferred events are replayed through appendEvent
  // in executeLoop's resume path, right after the sequence rebuild.
  private deferAppends = false;
  private deferredEvents: Array<{
    event_type: EventType;
    opts: {
      node_id?: string;
      action?: Action;
      internal_type?: string;
      internal_payload?: Record<string, unknown>;
    };
  }> = [];

  /**
   * Append an event to the durable event log.
   *
   * The write starts immediately but is not awaited here — `flushEventLog()`
   * (called from `persistState()`) awaits every outstanding append before
   * the state snapshot commits. Failures are tracked there; sequence
   * conflicts are remembered and re-thrown as fatal.
   */
  private appendEvent(
    event_type: EventType,
    opts: {
      node_id?: string;
      action?: Action;
      internal_type?: string;
      internal_payload?: Record<string, unknown>;
    } = {},
  ): void {
    if (this.deferAppends) {
      this.deferredEvents.push({ event_type, opts });
      return;
    }
    const event = {
      run_id: this.state.run_id,
      sequence_id: this.sequenceId++,
      event_type,
      ...opts,
    };
    const promise = this.eventLog.append(event).then(
      () => ({ ok: true }),
      (error) => {
        if (error instanceof EventSequenceConflictError || error instanceof StaleClaimError) {
          this.eventLogFatalError = error;
        }
        logger.error('event_log_append_failed', error, {
          run_id: this.state.run_id,
          sequence_id: event.sequence_id,
          event_type,
        });
        return { ok: false };
      },
    );
    this.pendingAppends.push(promise);
  }

  /**
   * Await all outstanding event-log appends.
   *
   * Called by `persistState()` as a write barrier: events must be durable
   * before the snapshot that reflects them. Without this barrier a crash
   * could leave a snapshot whose history is missing from the log, and
   * event-log recovery would silently reconstruct an older state.
   *
   * @throws {EventSequenceConflictError} If any append collided with an
   *   existing sequence_id — another writer owns this run.
   * @throws {Error} After {@link MAX_EVENT_LOG_FAILURES} consecutive
   *   flushes containing failures (same rule as snapshot persistence).
   */
  private async flushEventLog(): Promise<void> {
    if (this.pendingAppends.length === 0) return;
    const pending = this.pendingAppends;
    this.pendingAppends = [];
    const results = await Promise.all(pending);

    if (this.eventLogFatalError) {
      throw this.eventLogFatalError;
    }

    const failed = results.filter(r => !r.ok).length;
    if (failed > 0) {
      this.eventLogFailures++;
      logger.error('event_log_flush_failed', new Error(`${failed} append(s) failed`), {
        run_id: this.state.run_id,
        consecutive_failed_flushes: this.eventLogFailures,
      });
      if (this.eventLogFailures >= GraphRunner.MAX_EVENT_LOG_FAILURES) {
        throw new Error(
          `Event log unavailable after ${this.eventLogFailures} consecutive failed flushes. ` +
          `Halting workflow to prevent unrecoverable event-log divergence.`,
        );
      }
    } else {
      this.eventLogFailures = 0;
    }
  }

  /**
   * Build the context object passed to node executor functions.
   *
   * Delegates to {@link buildExecutorContext} in `executor-context-builder.ts`.
   * We pass an adapter object built fresh on each call — closures inside the
   * context dereference the runner reference at call time, so late state
   * mutations (token streaming, cost accumulation) are visible to them.
   */
  private buildExecutorContext(): NodeExecutorContext {
    // Adapter object — exposes only the fields the context builder needs.
    // Property GETTERS, not snapshots, so the closures see live `this.state`,
    // `this.isStreaming`, etc.
    const self = this;
    const adapter: ExecutorContextRunner = {
      get graph() { return self.graph; },
      get state() { return self.state; },
      get isStreaming() { return self.isStreaming; },
      get tokenChannel() { return self.channel.tokenBuffer; },
      get tokenNotify() { return self.channel.currentNotify; },
      get abortSignal() { return self.abortController.signal; },
      get onToken() { return self.onToken; },
      get loadGraphFn() { return self.loadGraphFn; },
      get modelResolver() { return self.modelResolver; },
      get contextCompressor() { return self.contextCompressor; },
      get memoryRetriever() { return self.memoryRetriever; },
      get memoryWriter() { return self.memoryWriter; },
      get factSanitizer() { return self.factSanitizer; },
      get factSanitizerFailMode() { return self.factSanitizerFailMode; },
      get fitnessFunction() { return self.fitnessFunction; },
      get rateLimiter() { return self.rateLimiter; },
      get toolResolver() { return self.toolResolver; },
      emit: (event, payload) => self.emit(event, payload),
      listenerCount: (event) => self.listenerCount(event),
    };
    return buildExecutorContextFn(adapter);
  }

  /**
   * Drain buffered streaming events from helper methods. Delegates to the
   * {@link StreamChannel} — kept as a thin wrapper because the executeLoop
   * generator references `this.drainPendingEvents()` at many call sites and
   * inlining would clutter the diff.
   */
  private *drainPendingEvents(): Generator<StreamEvent> {
    yield* this.channel.drainPending();
  }

  /**
   * Execute a node and interleave real-time token deltas.
   * Uses Promise.race to yield tokens as they arrive from the LLM.
   */
  private async *executeNodeAndDrainTokens(node: GraphNode): AsyncGenerator<StreamEvent, Action> {
    this.channel.clearTokens();
    const actionPromise = this.executeNodeWithTimeout(node);
    let resolved = false;

    actionPromise.then(
      () => { resolved = true; this.channel.notify(); },
      () => { resolved = true; this.channel.notify(); },
    );

    while (!resolved) {
      yield* this.channel.drainTokens();
      if (resolved) break;
      await this.channel.waitForNotify();
    }
    // Drain remaining tokens after node completes
    yield* this.channel.drainTokens();
    return await actionPromise;
  }

  /**
   * Core execution loop as an async generator.
   * Yields StreamEvent objects at each step. Both stream() and run() consume this.
   */
  private async *executeLoop(): AsyncGenerator<StreamEvent> {
    this.startTime = Date.now();

    // Validate graph structure before running
    const validation = validateGraph(this.graph);
    if (!validation.valid) {
      const errorMsg = `Graph validation failed: ${validation.errors.join(', ')}`;
      logger.error('graph_validation_failed', new Error(errorMsg), { graph_id: this.graph.id });
      this.dispatchInternal('_fail', { last_error: errorMsg });
      await this.persistState();
      yield* this.drainPendingEvents();
      this.lastRunError = new Error(errorMsg);
      yield {
        type: 'workflow:failed',
        workflow_id: this.state.workflow_id,
        run_id: this.state.run_id,
        error: errorMsg,
        state: this.state,
        timestamp: Date.now(),
      };
      return;
    }

    // Pre-flight wiring checks: catch missing runner dependencies BEFORE any
    // node runs, instead of failing mid-run after upstream nodes already spent
    // tokens (and, for some, being pointlessly retried).
    const wiring = this.checkRuntimeWiring();
    if (wiring.errors.length > 0) {
      const errorMsg = `Runner wiring error: ${wiring.errors.join(', ')}`;
      logger.error('runner_wiring_failed', new Error(errorMsg), { graph_id: this.graph.id });
      this.dispatchInternal('_fail', { last_error: errorMsg });
      await this.persistState();
      yield* this.drainPendingEvents();
      this.lastRunError = new Error(errorMsg);
      yield {
        type: 'workflow:failed',
        workflow_id: this.state.workflow_id,
        run_id: this.state.run_id,
        error: errorMsg,
        state: this.state,
        timestamp: Date.now(),
      };
      return;
    }
    for (const w of wiring.warnings) {
      logger.warn('runner_wiring_warning', { graph_id: this.graph.id, warning: w });
    }

    // Log validation warnings
    if (validation.warnings.length > 0) {
      logger.warn('graph_validation_warnings', { warnings: validation.warnings });
    }

    logger.info('execution_started', { graph_id: this.graph.id, workflow_id: this.state.workflow_id, run_id: this.state.run_id });
    incrementWorkflowsStarted({ graph_id: this.graph.id });

    this.emit('workflow:start', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
    yield {
      type: 'workflow:start',
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
      timestamp: Date.now(),
    };

    // Detect resume: if state already has visited nodes, we're resuming from a checkpoint
    const isResume = this.state.visited_nodes.length > 0 && this.state.current_node;
    if (isResume) {
      // Check for expired approval gate timeout BEFORE re-entering the loop.
      // If the workflow was paused at an approval node and the timeout has
      // expired since the last run, transition directly to 'timeout'.
      if (this.state.status === 'waiting' && this.state.waiting_timeout_at
          && new Date() >= this.state.waiting_timeout_at) {
        logger.info('approval_timeout_expired_on_resume', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          waiting_timeout_at: this.state.waiting_timeout_at.toISOString(),
        });
        this.dispatchInternal('_timeout');
        await this.persistState();
        yield* this.drainPendingEvents();

        const elapsed = Date.now() - (this.startTime ?? Date.now());
        this.lastRunError = new WorkflowTimeoutError(
          this.state.workflow_id,
          this.state.run_id,
          elapsed,
        );
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
        });
        yield {
          type: 'workflow:timeout',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
          state: this.state,
          timestamp: Date.now(),
        };
        return;
      }

      logger.info('resuming_from_checkpoint', {
        current_node: this.state.current_node,
        iteration: this.state.iteration_count,
        visited: this.state.visited_nodes.length,
      });
      // Advance sequenceId past the existing log BEFORE dispatching anything:
      // a checkpoint-constructed runner starts at sequenceId 0, and appending
      // the resume _init with a stale id would collide with an existing event
      // (rejected by the writer → spurious split-brain error).
      const rebuild = await this.idempotency.rebuildFromEventLog(
        this.eventLog,
        this.state.run_id,
        {
          current_node: this.state.current_node,
          iteration_count: this.state.iteration_count,
          _last_event_sequence_id: this.state._last_event_sequence_id,
        },
      );
      // The tracker doesn't own sequenceId — advance it ourselves so the event
      // log stays continuous after replay.
      if (rebuild.maxSequenceId !== null && rebuild.maxSequenceId + 1 > this.sequenceId) {
        this.sequenceId = rebuild.maxSequenceId + 1;
      }
      this.dispatchInternal('_init', { resume: true });
    } else {
      this.dispatchInternal('_init', { start_node: this.graph.start_node });
    }

    // Record events deferred from before execution (applyHumanResponse) —
    // sequenceId is now guaranteed past the run's existing log.
    if (this.deferredEvents.length > 0) {
      const deferred = this.deferredEvents;
      this.deferredEvents = [];
      for (const { event_type, opts } of deferred) {
        this.appendEvent(event_type, opts);
      }
    }

    await this.persistState();
    yield* this.drainPendingEvents();

    // Log workflow_started event. Carries the reducer replay version so
    // recovery can detect logs written under different reducer semantics.
    this.appendEvent('workflow_started', {
      internal_payload: { replay_version: REPLAY_VERSION },
    });

    // The `workflow.run` span is established by run(); stream() consumers can
    // wrap their own consumption loop if they want a root span.
    try {
      while (shouldContinue(this.state) && !this.abortController.signal.aborted) {
        // Check global timeout
        if (this.checkTimeout()) {
          await this.persistState();
          yield* this.drainPendingEvents();

          const elapsed_ms = Date.now() - (this.startTime ?? Date.now());
          this.lastRunError = new WorkflowTimeoutError(
            this.state.workflow_id,
            this.state.run_id,
            elapsed_ms,
          );
          yield {
            type: 'workflow:timeout',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            elapsed_ms,
            state: this.state,
            timestamp: Date.now(),
          };
          return;
        }

        const currentNode = getCurrentNode(this.nodeMap, this.state);
        if (!currentNode) {
          logger.error('node_not_found', new Error(`Node not found: ${this.state.current_node}`));
          this.dispatchInternal('_fail', { last_error: `Node not found: ${this.state.current_node}` });
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Idempotency: if this (node, iteration) action was already reduced
        // into state before a crash (post-persist, pre-advance window), the
        // snapshot we resumed from contains its effects. Re-executing would
        // double-apply the action and double-spend the LLM call — skip the
        // node entirely and perform only the routing the crash interrupted.
        const executionIteration = this.state.iteration_count;
        if (this.idempotency.has(currentNode.id, executionIteration)) {
          logger.warn('duplicate_node_execution_skipped', {
            node_id: currentNode.id,
            iteration: executionIteration,
            run_id: this.state.run_id,
          });

          this.dispatchInternal('_increment_iteration');
          if (this.state.iteration_count >= this.state.max_iterations) {
            this.dispatchInternal('_fail', { last_error: `Max iterations reached: ${this.state.iteration_count}` });
            await this.persistState();
            yield* this.drainPendingEvents();
            break;
          }
          if (this.graph.end_nodes.includes(currentNode.id)) {
            this.dispatchInternal('_complete');
            await this.persistState();
            yield* this.drainPendingEvents();
            break;
          }
          const skipNext = getNextNode(this.edgeMap, this.nodeMap, currentNode, this.state);
          if (!skipNext) {
            this.dispatchInternal('_complete');
            await this.persistState();
            yield* this.drainPendingEvents();
            break;
          }
          this.dispatchInternal('_advance', { node_id: skipNext.id });
          await this.persistState();
          yield* this.drainPendingEvents();
          continue;
        }

        // Log node_started event before execution
        this.appendEvent('node_started', { node_id: currentNode.id });

        // Middleware context (built once per iteration, reused across hooks)
        const mwCtx: MiddlewareContext | undefined = this.middleware.length > 0
          ? { node: currentNode, state: this.state, graph: this.graph, iteration: this.state.iteration_count }
          : undefined;

        // Hook: beforeNodeExecute — can short-circuit node execution
        let action: Action | undefined;
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.beforeNodeExecute) {
              const result = await mw.beforeNodeExecute(mwCtx);
              if (result?.shortCircuit) {
                action = result.shortCircuit;
                break;
              }
            }
          }
        }

        // Execute node (with real-time token streaming when in streaming mode)
        const nodeStartTime = Date.now();
        if (!action) {
          if (this.isStreaming) {
            yield { type: 'node:start', node_id: currentNode.id, node_type: currentNode.type, timestamp: nodeStartTime };
            this.emit('node:start', { node_id: currentNode.id, type: currentNode.type, timestamp: nodeStartTime });

            // Drain any pending retry events from executeNodeWithRetry
            try {
              const gen = this.executeNodeAndDrainTokens(currentNode);
              let genResult = await gen.next();
              while (!genResult.done) {
                yield genResult.value;
                genResult = await gen.next();
              }
              action = genResult.value;
            } catch (nodeError) {
              // Drain retry events that were pushed during retries
              yield* this.drainPendingEvents();
              const errorMessage = nodeError instanceof Error ? nodeError.message : String(nodeError);
              yield {
                type: 'node:failed',
                node_id: currentNode.id,
                node_type: currentNode.type,
                error: errorMessage,
                attempt: currentNode.failure_policy.max_retries,
                timestamp: Date.now(),
              };
              this.emit('node:failed', { node_id: currentNode.id, type: currentNode.type, error: errorMessage, attempt: currentNode.failure_policy.max_retries });
              throw nodeError;
            }

            // Drain retry events accumulated during successful retries
            yield* this.drainPendingEvents();

            const duration_ms = Date.now() - nodeStartTime;
            yield { type: 'node:complete', node_id: currentNode.id, node_type: currentNode.type, duration_ms, timestamp: Date.now() };
            this.emit('node:complete', { node_id: currentNode.id, type: currentNode.type, duration_ms });
          } else {
            // Node span + run context are established inside
            // executeNodeWithTimeout, so both this branch and the streaming
            // branch above are covered uniformly.
            action = await this.executeNodeWithTimeout(currentNode);
          }
        }

        // Hook: afterNodeExecute — can transform action before reduce
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.afterNodeExecute) {
              const transformed = await mw.afterNodeExecute(mwCtx, action);
              if (transformed) {
                action = transformed;
              }
            }
          }
        }

        // Validate action schema — reject invalid actions
        const validationResult = ActionSchema.safeParse(action);
        if (!validationResult.success) {
          throw new Error(
            `Node "${currentNode.id}" returned invalid action: ${validationResult.error.issues.map(i => i.message).join(', ')}`
          );
        }

        // Validate action against permissions
        if (!validateAction(action, currentNode.write_keys)) {
          throw new PermissionDeniedError(`Node ${currentNode.id} tried to write to unauthorized keys`);
        }

        // Track compensation (saga pattern)
        if (currentNode.requires_compensation && action.compensation) {
          this.dispatchInternal('_push_compensation', {
            action_id: action.id,
            compensation_action: action.compensation,
          });
        }

        // Merge child subgraph compensation entries into parent stack
        if (action.compensation_entries && action.compensation_entries.length > 0) {
          for (const entry of action.compensation_entries) {
            this.dispatchInternal('_push_compensation', {
              action_id: entry.action_id,
              compensation_action: entry.compensation_action,
            });
          }
        }

        // Capture memory before reducer for diff computation
        const memoryBefore = this.state.memory;
        const memoryDropsLengthBefore = this.state.memory_drops?.length ?? 0;

        // Apply action via reducer
        this.state = rootReducer(this.state, action);

        // Mark applied AFTER the reduce succeeds — the marker means "this
        // (node, iteration)'s effects are in state", which is what the
        // pre-execution duplicate check above relies on.
        this.idempotency.add(currentNode.id, executionIteration);

        // Compute memory diff
        const memoryAfter = this.state.memory;
        const memoryDiff = computeMemoryDiff(memoryBefore, memoryAfter);

        // Surface any new memory drops as stream events. The reducer records
        // drops in `state.memory_drops` (durable audit log); the stream event
        // is the live notification path.
        const newDrops = (this.state.memory_drops ?? []).slice(memoryDropsLengthBefore);
        for (const drop of newDrops) {
          yield {
            type: 'memory:dropped',
            run_id: this.state.run_id,
            node_id: drop.node_id ?? currentNode.id,
            key: drop.key,
            reason: drop.reason,
            ...(drop.bytes !== undefined ? { bytes: drop.bytes } : {}),
            timestamp: Date.now(),
          };
          logger.warn('memory_dropped', {
            run_id: this.state.run_id,
            node_id: drop.node_id ?? currentNode.id,
            key: drop.key,
            reason: drop.reason,
            bytes: drop.bytes,
          });
        }

        // Hook: afterReduce — observational, after reducer
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.afterReduce) {
              await mw.afterReduce(mwCtx, action, this.state);
            }
          }
        }

        // Log action_dispatched event (captures full Action including LLM response)
        this.appendEvent('action_dispatched', { node_id: currentNode.id, action });

        // Track cumulative token usage from agent/supervisor executions
        const tokenUsage = action.metadata.token_usage;
        if (tokenUsage?.totalTokens && typeof tokenUsage.totalTokens === 'number') {
          this.dispatchInternal('_track_tokens', { tokens: tokenUsage.totalTokens });
        }

        // Track cumulative cost from token usage. Also compute the
        // per-action cost so the per-node budget check below has it.
        let actionCostUsd = 0;
        if (tokenUsage?.inputTokens !== undefined || tokenUsage?.outputTokens !== undefined) {
          const inputTokens = tokenUsage.inputTokens ?? 0;
          const outputTokens = tokenUsage.outputTokens ?? 0;
          actionCostUsd = this.budget.calculateActionCost(inputTokens, outputTokens, action);
          if (actionCostUsd > 0) {
            this.dispatchInternal('_track_cost', { cost_usd: actionCostUsd });
            await this.budget.checkThresholds(this.state);
            yield* this.drainPendingEvents();
          }
        }

        // Enforce per-node budget (max_tokens / max_cost_usd). Stops the
        // workflow immediately on breach — no retry, since a retry would
        // just compound the spend.
        if (currentNode.budget) {
          const nodeTokens = tokenUsage?.totalTokens ?? 0;
          if (
            currentNode.budget.max_tokens !== undefined &&
            nodeTokens > currentNode.budget.max_tokens
          ) {
            logger.warn('node_budget_exceeded', {
              node_id: currentNode.id,
              limit: 'max_tokens',
              used: nodeTokens,
              cap: currentNode.budget.max_tokens,
            });
            this.dispatchInternal('_fail', {
              last_error: `Node "${currentNode.id}" exceeded max_tokens: ${nodeTokens} > ${currentNode.budget.max_tokens}`,
            });
            await this.persistState();
            yield* this.drainPendingEvents();
            throw new NodeBudgetExceededError(
              currentNode.id,
              'max_tokens',
              nodeTokens,
              currentNode.budget.max_tokens,
            );
          }
          if (
            currentNode.budget.max_cost_usd !== undefined &&
            actionCostUsd > currentNode.budget.max_cost_usd
          ) {
            logger.warn('node_budget_exceeded', {
              node_id: currentNode.id,
              limit: 'max_cost_usd',
              used: actionCostUsd,
              cap: currentNode.budget.max_cost_usd,
            });
            this.dispatchInternal('_fail', {
              last_error: `Node "${currentNode.id}" exceeded max_cost_usd: $${actionCostUsd.toFixed(4)} > $${currentNode.budget.max_cost_usd.toFixed(4)}`,
            });
            await this.persistState();
            yield* this.drainPendingEvents();
            throw new NodeBudgetExceededError(
              currentNode.id,
              'max_cost_usd',
              actionCostUsd,
              currentNode.budget.max_cost_usd,
            );
          }
        }

        // Enforce token budget
        if (this.state.max_token_budget && this.state.total_tokens_used > this.state.max_token_budget) {
          const errorMsg = `Token budget exceeded: ${this.state.total_tokens_used} tokens used, budget was ${this.state.max_token_budget}`;
          logger.warn('budget_exceeded', {
            total_tokens: this.state.total_tokens_used,
            budget: this.state.max_token_budget,
            node_id: currentNode.id,
          });
          this.dispatchInternal('_budget_exceeded', { last_error: errorMsg });
          await this.persistState();
          yield* this.drainPendingEvents();
          throw new BudgetExceededError(this.state.total_tokens_used, this.state.max_token_budget);
        }

        yield {
          type: 'action:applied',
          action_id: action.id,
          action_type: action.type,
          node_id: currentNode.id,
          memory_diff: memoryDiff,
          timestamp: Date.now(),
        };
        this.emit('action:applied', {
          action_id: action.id,
          type: action.type,
          node_id: currentNode.id,
        });

        // Persist after every step (resumability)
        await this.persistState();
        yield* this.drainPendingEvents();

        // Check for graceful shutdown
        if (this._shuttingDown) {
          logger.info('graceful_shutdown', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            current_node: this.state.current_node,
          });
          this.emit('workflow:paused', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
          });
          yield {
            type: 'workflow:paused',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            state: this.state,
            timestamp: Date.now(),
          };
          break;
        }

        // Advance iteration count (every node execution counts)
        this.dispatchInternal('_increment_iteration');

        // Check for cycles/max iterations
        if (this.state.iteration_count >= this.state.max_iterations) {
          logger.warn('max_iterations_reached', { iteration_count: this.state.iteration_count, max: this.state.max_iterations });
          this.dispatchInternal('_fail', { last_error: `Max iterations reached: ${this.state.iteration_count}` });
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Check if current node is an end node — if so, we're done
        if (this.graph.end_nodes.includes(currentNode.id)) {
          logger.info('execution_complete_at_end_node', { node_id: currentNode.id, graph_id: this.graph.id, run_id: this.state.run_id });
          this.dispatchInternal('_complete');
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Flow-control actions already manage state transitions via their reducers
        if (action.type === 'handoff' || action.type === 'set_status' || action.type === 'request_human_input') {
          await this.persistState();
          yield* this.drainPendingEvents();
          continue;
        }

        // Determine next node from outgoing edges. We already returned above
        // if this were an end node, so reaching here with no match is a
        // dead-end: fail loud instead of silently "completing" a partial run.
        let nextNode = getNextNode(this.edgeMap, this.nodeMap, currentNode, this.state);
        if (!nextNode) {
          if (this.allowImplicitCompletion) {
            logger.info('execution_complete', { graph_id: this.graph.id, run_id: this.state.run_id });
            this.dispatchInternal('_complete');
            await this.persistState();
            yield* this.drainPendingEvents();
            break;
          }
          // Dead-end → fail loud (mirrors the graph-validation failure path).
          const deadEnd = new NoMatchingEdgeError(currentNode.id);
          logger.error('no_matching_edge', deadEnd, { graph_id: this.graph.id, run_id: this.state.run_id, node_id: currentNode.id });
          this.dispatchInternal('_fail', { last_error: deadEnd.message });
          await this.persistState();
          yield* this.drainPendingEvents();
          this.lastRunError = deadEnd;
          incrementWorkflowsFailed({ graph_id: this.graph.id });
          this.emit('workflow:failed', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            error: deadEnd.message,
          });
          yield {
            type: 'workflow:failed',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            error: deadEnd.message,
            state: this.state,
            timestamp: Date.now(),
          };
          return;
        }

        // Hook: beforeAdvance — can override routing
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.beforeAdvance) {
              const overrideId = await mw.beforeAdvance(mwCtx, nextNode.id);
              if (overrideId) {
                const overrideNode = this.nodeMap.get(overrideId);
                if (overrideNode) {
                  nextNode = overrideNode;
                }
              }
            }
          }
        }

        // Advance current_node to the next node
        this.dispatchInternal('_advance', { node_id: nextNode.id });
        await this.persistState();
        yield* this.drainPendingEvents();
      }

      const duration_ms = Date.now() - (this.startTime ?? Date.now());

      if (this.state.status === 'completed') {
        incrementWorkflowsCompleted({ graph_id: this.graph.id });
        recordWorkflowDuration(duration_ms, { status: 'completed', graph_id: this.graph.id });
        recordTokensUsed(this.state.total_tokens_used, { graph_id: this.graph.id });
        if (this.state.total_cost_usd > 0) {
          recordCostUsd(this.state.total_cost_usd, { graph_id: this.graph.id });
        }
        this.emit('workflow:complete', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms,
        });
        yield {
          type: 'workflow:complete',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms,
          state: this.state,
          timestamp: Date.now(),
        };
      } else if (this.state.status === 'waiting') {
        // Check if approval gate timeout has already expired
        if (this.state.waiting_timeout_at && new Date() >= this.state.waiting_timeout_at) {
          this.dispatchInternal('_timeout');
          await this.persistState();
          yield* this.drainPendingEvents();
          // Fall through to timeout handling below
        }

        if (this.state.status === 'waiting') {
          // No timeout expired — emit waiting event and return
          this.emit('workflow:waiting', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            waiting_for: this.state.waiting_for || 'human_approval',
          });
          yield {
            type: 'workflow:waiting',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            waiting_for: this.state.waiting_for || 'human_approval',
            state: this.state,
            timestamp: Date.now(),
          };
        }
      }

      if (this.state.status === 'timeout') {
        const elapsed = Date.now() - (this.startTime ?? Date.now());
        this.lastRunError = new WorkflowTimeoutError(
          this.state.workflow_id,
          this.state.run_id,
          elapsed,
        );
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
        });
        yield {
          type: 'workflow:timeout',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
          state: this.state,
          timestamp: Date.now(),
        };
      }
    } catch (error) {
      // If aborted via cancel(), don't overwrite the cancelled status
      if (this.abortController.signal.aborted && this.state.status === 'cancelled') {
        return;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.lastRunError = err;

      // Execute compensation actions if auto_rollback is enabled and compensation stack is non-empty
      let rollbackSucceeded = false;
      if (this.autoRollback && this.state.compensation_stack.length > 0) {
        try {
          await this.rollback();
          rollbackSucceeded = true;
        } catch (rollbackError) {
          logger.error('auto_rollback_failed', rollbackError as Error, {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
          });
        }
      }

      // If rollback succeeded, state is already 'cancelled' — skip _fail dispatch
      if (!rollbackSucceeded) {
        this.dispatchInternal('_fail', { last_error: err.message });
        await this.persistState();
        yield* this.drainPendingEvents();

        incrementWorkflowsFailed({ graph_id: this.graph.id });
        recordWorkflowDuration(Date.now() - (this.startTime ?? Date.now()), {
          status: 'failed',
          graph_id: this.graph.id,
        });

        this.emit('workflow:failed', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          error: this.state.last_error,
        });
        yield {
          type: 'workflow:failed',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          error: err.message,
          state: this.state,
          timestamp: Date.now(),
        };
      }
    } finally {
      this.isStreaming = false;
      // Final barrier: ensure trailing appends (terminal events dispatched
      // after the last persist) are durable before the generator returns.
      // Failures here are logged, not thrown — the run is already over and
      // throwing from a finally would mask the run's real outcome.
      await this.flushEventLog().catch((error) => {
        logger.error('event_log_final_flush_failed', error, {
          run_id: this.state.run_id,
        });
      });
    }
  }

  /**
   * Stream workflow execution events as an async generator.
   *
   * This is the canonical execution path. Each event is yielded as it
   * occurs, including real-time token deltas from LLM agents. Terminal
   * events carry the full `WorkflowState`.
   *
   * @example
   * ```ts
   * const runner = new GraphRunner(graph, state, opts);
   * for await (const event of runner.stream()) {
   *   if (event.type === 'agent:token_delta') process.stdout.write(event.token);
   *   if (event.type === 'workflow:complete') console.log(event.state.status);
   * }
   * ```
   */
  async *stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    if (options?.signal) {
      if (options.signal.aborted) {
        this.cancel();
      } else {
        options.signal.addEventListener('abort', () => this.cancel(), { once: true });
      }
    }
    this.isStreaming = true;
    yield* this.executeLoop();
  }

  /**
   * Execute the graph until completion or max iterations.
   *
   * Consumes `stream()` internally and returns the final state.
   * Preserves original error types for backward compatibility.
   */
  async run(): Promise<WorkflowState> {
    this.lastRunError = undefined;
    try {
      // Establish run-correlation context so every downstream log line
      // (agent executor, MCP, provider, persistence) carries run_id/graph_id
      // without threading them through every call. Covers the whole
      // non-streaming / worker path. The `workflow.run` root span wraps the
      // entire run so node/agent spans nest under it in traces.
      await runWithContext(
        { run_id: this.state.run_id, graph_id: this.graph.id },
        () => withSpan(tracer, 'workflow.run', async (runSpan) => {
          runSpan.setAttribute('workflow.run_id', this.state.run_id);
          runSpan.setAttribute('graph.id', this.graph.id);
          for await (const _event of this.executeLoop()) {
            // Drain all events — run() consumes but discards them
          }
        }),
      );
    } finally {
      // Close MCP connections opened during this run
      if (this.toolResolver) {
        await this.toolResolver.closeAll().catch((err) => {
          logger.error('tool_resolver_cleanup_failed', err as Error);
        });
      }

      // Prevent memory leaks: remove all event listeners registered by
      // consumers of this runner. Without this, long-lived worker processes
      // that create thousands of GraphRunner instances would accumulate
      // orphaned listeners.
      this.removeAllListeners();
    }
    if (this.lastRunError) throw this.lastRunError;
    return this.state;
  }

  /**
   * Execute a single node with retry logic.
   *
   * When `isStreaming`, node lifecycle events (start/complete/failed)
   * are emitted by `executeLoop()` instead to avoid double-emission.
   */
  private async executeNode(node: GraphNode): Promise<Action> {
    const nodeStartTime = Date.now();

    if (!this.isStreaming) {
      this.emit('node:start', {
        node_id: node.id,
        type: node.type,
        timestamp: nodeStartTime,
      });
    }

    try {
      // Execute with retry
      const action = await this.executeNodeWithRetry(node);

      const duration_ms = Date.now() - nodeStartTime;

      if (!this.isStreaming) {
        this.emit('node:complete', {
          node_id: node.id,
          type: node.type,
          duration_ms,
        });
      }

      return action;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (!this.isStreaming) {
        this.emit('node:failed', {
          node_id: node.id,
          type: node.type,
          error: errorMessage,
          attempt: node.failure_policy.max_retries,
        });
      }

      throw error;
    }
  }

  /**
   * Execute node with retry and circuit breaker
   */
  /**
   * Count tokens/cost spent on a failed agent attempt. Reads the best-effort
   * `partialUsage` that the agent executor attaches to its typed errors and
   * dispatches the same `_track_tokens` / `_track_cost` internal actions the
   * success path uses, so failed-attempt spend is visible to every budget.
   */
  private trackFailedAttemptUsage(error: unknown): void {
    const usage = (error as { partialUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; model?: string } })?.partialUsage;
    if (!usage) return;

    const totalTokens = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    if (totalTokens > 0) {
      this.dispatchInternal('_track_tokens', { tokens: totalTokens });
    }
    if (usage.model && (usage.inputTokens || usage.outputTokens)) {
      const cost = calculateCost(usage.model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
      if (cost > 0) {
        this.dispatchInternal('_track_cost', { cost_usd: cost });
      }
    }
  }

  private async executeNodeWithRetry(node: GraphNode): Promise<Action> {
    const policy = node.failure_policy;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= policy.max_retries; attempt++) {
      try {
        // Check circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.check(node);
        }

        // Execute node
        const action = await this.executeNodeLogic(node, attempt);

        // Success: update circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.update(node.id, true, this.graph.nodes);
        }

        return action;
      } catch (error) {
        lastError = error as Error;

        // Account for tokens spent on this FAILED attempt. The agent executor
        // attaches best-effort partial usage to AgentExecutionError /
        // AgentTimeoutError; without this, a node that retries N times only
        // ever counts the successful attempt's tokens, hiding up to N×
        // the visible spend from every budget.
        this.trackFailedAttemptUsage(error);

        // Update circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.update(node.id, false, this.graph.nodes);
        }

        // Short-circuit on a definitively non-retryable error (e.g. a 400
        // invalid-request or context-length-exceeded). Retrying would re-issue
        // an identical request that fails the same way — pure wasted spend.
        // Only `retryable === false` short-circuits; `undefined` (unknown
        // error) still retries.
        if ((error as { retryable?: boolean })?.retryable === false) {
          logger.warn('node_error_non_retryable', { node_id: node.id, attempt, error: lastError?.message });
          break;
        }

        const is_last_attempt = attempt === policy.max_retries;
        if (is_last_attempt) break;

        // Calculate backoff and retry
        const backoff_ms = calculateBackoff(
          attempt,
          policy.backoff_strategy,
          policy.initial_backoff_ms,
          policy.max_backoff_ms
        );

        this.emit('node:retry', { node_id: node.id, attempt, backoff_ms });
        if (this.isStreaming) {
          this.channel.pushPending({
            type: 'node:retry',
            node_id: node.id,
            attempt,
            backoff_ms,
            timestamp: Date.now(),
          });
        }
        logger.warn('node_retry', { node_id: node.id, attempt, backoff_ms, error: lastError?.message });

        await sleep(backoff_ms);
      }
    }

    throw lastError || new Error(`Node ${node.id} failed after ${policy.max_retries} retries`);
  }

  /**
   * Execute node logic based on type — dispatches to extracted executor functions.
   */
  private async executeNodeLogic(node: GraphNode, attempt: number): Promise<Action> {
    // Create state view (security boundary)
    const stateView = createStateView(this.state, node);
    const ctx = this.buildExecutorContext();

    // Dispatch via the node-executor registry (a compiler-exhaustive
    // Record<NodeType, NodeExecutor>) instead of a hand-maintained switch.
    const executor = getNodeExecutor(node.type);
    if (!executor) {
      throw new UnsupportedNodeTypeError(node.type);
    }
    return await executor(node, stateView, attempt, ctx);
  }

  /**
   * Apply human response and prepare for resumption.
   * Called by the worker before run() on HITL resume.
   */
  applyHumanResponse(response: HumanResponse): void {
    // Defer event appends until run()/stream() resumes: this method is
    // called before execution, when a freshly-constructed runner's
    // sequenceId hasn't been advanced past the run's existing event log yet.
    this.deferAppends = true;
    try {
      this.applyHumanResponseInner(response);
    } finally {
      this.deferAppends = false;
    }
  }

  private applyHumanResponseInner(response: HumanResponse): void {
    const pendingApproval = this.state.memory._pending_approval as {
      node_id?: string;
      rejection_node_id?: string;
    } | undefined;

    // Create and apply resume action
    const action: Action = {
      id: uuidv4(),
      idempotency_key: `resume:${this.state.run_id}:${Date.now()}`,
      type: 'resume_from_human',
      payload: {
        decision: response.decision,
        response: response.data,
        memory_updates: response.memory_updates,
      },
      metadata: {
        node_id: pendingApproval?.node_id || 'unknown',
        timestamp: new Date(),
        attempt: 1,
      },
    };

    this.state = rootReducer(this.state, action);

    // Durably record the human decision BEFORE the _advance dispatches below,
    // so event-log replay applies the resume in the same order as the live
    // run. Without this, a recovered run would reconstruct state without the
    // human's response.
    this.appendEvent('action_dispatched', {
      node_id: action.metadata.node_id,
      action,
    });

    // Handle rejection routing
    if (response.decision === 'rejected' && pendingApproval?.rejection_node_id) {
      const rejectionNode = this.graph.nodes.find(n => n.id === pendingApproval.rejection_node_id);
      if (rejectionNode) {
        this.dispatchInternal('_advance', { node_id: rejectionNode.id });
      }
    } else if (response.decision !== 'rejected') {
      // Advance to next node from the approval node
      const approvalNode = this.graph.nodes.find(n => n.id === pendingApproval?.node_id);
      if (approvalNode) {
        const nextNode = getNextNode(this.edgeMap, this.nodeMap, approvalNode, this.state);
        if (nextNode) {
          this.dispatchInternal('_advance', { node_id: nextNode.id });
        }
      }
    }
  }

  /**
   * Rollback workflow using compensation stack (saga pattern)
   */
  async rollback(): Promise<void> {
    logger.info('rollback_started', { workflow_id: this.state.workflow_id, compensation_count: this.state.compensation_stack.length });

    // Execute compensation actions in reverse order (LIFO)
    while (this.state.compensation_stack.length > 0) {
      const compensatable = this.state.compensation_stack[this.state.compensation_stack.length - 1];
      this.dispatchInternal('_pop_compensation');

      if (!compensatable) continue;

      try {
        // Validate compensation action before applying
        const parsed = ActionSchema.safeParse(compensatable.compensation_action);
        if (!parsed.success) {
          logger.error('invalid_compensation_action', new Error('Compensation action failed schema validation'), {
            action_id: compensatable.action_id,
            errors: parsed.error.issues,
          });
          continue;
        }

        const compensation = parsed.data;
        logger.info('compensating_action', { action_id: compensatable.action_id });

        // Apply compensation
        this.state = rootReducer(this.state, compensation);

      } catch (error) {
        logger.error('compensation_failed', error, { action_id: compensatable.action_id });
        // Log but continue rolling back
      }
    }

    this.dispatchInternal('_cancel');
    await this.persistState();

    this.emit('workflow:rollback', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
  }

  /**
   * Check workflow timeout
   */
  private checkTimeout(): boolean {
    if (!this.state.started_at || !this.startTime) return false;

    const elapsed_ms = Date.now() - this.startTime;

    if (elapsed_ms > this.state.max_execution_time_ms) {
      logger.error('workflow_timeout', undefined, { elapsed_ms, max_ms: this.state.max_execution_time_ms, run_id: this.state.run_id });
      this.dispatchInternal('_timeout');
      // When streaming, timeout events are yielded by executeLoop()
      if (!this.isStreaming) {
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms,
        });
      }
      return true;
    }

    return false;
  }


  /**
   * Persist state to the configured persistence layer and trigger
   * auto-compaction when due. Delegates to {@link PersistenceCoordinator}.
   *
   * Flushes the event log FIRST — events are the snapshot's history and must
   * never be missing for a snapshot that exists. If the flush fails (below
   * the halt threshold) the snapshot still proceeds: the snapshot is the
   * stronger recovery anchor, and recovery reconciles the two by taking
   * whichever has more progress.
   */
  /**
   * Validate that the runner's injected dependencies match what the graph
   * needs, before execution starts. Returns hard errors (which fail the run
   * immediately) and soft warnings.
   *
   * Checks:
   *  - a `reflection` node requires `memoryWriter` (error — the executor
   *    would otherwise throw `MemoryWriterMissingError` mid-run).
   *  - a node declaring `mcp` tool sources requires `toolResolver` (error —
   *    otherwise the node silently runs with built-in tools only and
   *    "succeeds" with degraded output).
   *  - a node declaring `memory_query` benefits from `memoryRetriever`
   *    (warning — without it retrieval silently returns nothing).
   */
  private checkRuntimeWiring(): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const hasReflection = this.graph.nodes.some((n) => n.type === 'reflection');
    if (hasReflection && !this.memoryWriter) {
      errors.push(
        `graph has reflection node(s) but no memoryWriter was provided on GraphRunnerOptions`,
      );
    }

    if (!this.toolResolver) {
      for (const node of this.graph.nodes) {
        const declaresMcp = (node.tools ?? []).some((t) => t.type === 'mcp');
        if (declaresMcp) {
          errors.push(
            `node '${node.id}' declares MCP tool sources but no toolResolver was provided on GraphRunnerOptions`,
          );
        }
      }
    }

    if (!this.memoryRetriever) {
      const consumer = this.graph.nodes.find((n) => n.memory_query !== undefined);
      if (consumer) {
        warnings.push(
          `node '${consumer.id}' declares memory_query but no memoryRetriever was provided — retrieval will be skipped`,
        );
      }
    }

    return { errors, warnings };
  }

  private async persistState(): Promise<void> {
    // Stamp the snapshot with the event-log high-water mark BEFORE flushing:
    // every event with sequence_id <= this mark is durable by the time the
    // snapshot commits, so resume logic can decide whether a logged action's
    // effects are already inside this snapshot. Runner-internal bookkeeping —
    // not a reducer concern (no state semantics change).
    this.state = { ...this.state, _last_event_sequence_id: this.sequenceId - 1 };
    await this.flushEventLog();
    await this.persistence.persist(this.state, this.sequenceId);
  }

  /**
   * Execute node with timeout wrapper.
   * Uses AbortController to ensure the timeout handle is always cleaned up,
   * preventing timer leaks when the node completes before the timeout fires.
   */
  private async executeNodeWithTimeout(node: GraphNode): Promise<Action> {
    // Re-establish run context here too: under stream(), an external consumer
    // drives the generator outside run()'s runWithContext scope, so this
    // per-node chokepoint is where node/agent/MCP logs pick up run_id. The
    // node.execute span also lives here so BOTH the streaming and
    // non-streaming paths produce it (the streaming branch had none).
    return runWithContext(
      { run_id: this.state.run_id, graph_id: this.graph.id },
      () => withSpan(tracer, `node.execute.${node.type}`, (nodeSpan) => {
        nodeSpan.setAttribute('node.id', node.id);
        nodeSpan.setAttribute('node.type', node.type);
        nodeSpan.setAttribute('workflow.run_id', this.state.run_id);
        return this.executeNodeWithTimeoutInner(node);
      }),
    );
  }

  private async executeNodeWithTimeoutInner(node: GraphNode): Promise<Action> {
    const nodeTimeout = node.failure_policy.timeout_ms;

    // Calculate remaining workflow-level timeout
    let workflowTimeoutMs: number | undefined;
    if (this.startTime && this.state.max_execution_time_ms) {
      const elapsed = Date.now() - this.startTime;
      const remaining = this.state.max_execution_time_ms - elapsed;
      if (remaining <= 0) {
        // Already past deadline
        this.abortController.abort();
        throw new WorkflowTimeoutError(this.state.workflow_id, this.state.run_id, elapsed);
      }
      workflowTimeoutMs = remaining;
    }

    // Pick the tighter of node timeout and workflow timeout
    const effectiveTimeout = nodeTimeout && workflowTimeoutMs
      ? Math.min(nodeTimeout, workflowTimeoutMs)
      : nodeTimeout || workflowTimeoutMs;

    if (!effectiveTimeout) {
      return await this.executeNode(node);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const isWorkflowTimeout = workflowTimeoutMs !== undefined &&
      (!nodeTimeout || workflowTimeoutMs <= nodeTimeout);

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          // Fire abort signal so in-flight LLM calls are cancelled
          this.abortController.abort();
          if (isWorkflowTimeout) {
            const elapsed = Date.now() - (this.startTime ?? Date.now());
            reject(new WorkflowTimeoutError(this.state.workflow_id, this.state.run_id, elapsed));
          } else {
            reject(new Error(`Node ${node.id} timeout after ${effectiveTimeout}ms`));
          }
        }, effectiveTimeout);
      });

      return await Promise.race([
        this.executeNode(node),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  // Cost tracking lives in BudgetMonitor — see runner/budget-monitor.ts

  // ─── Durable Execution: Recovery ───────────────────────────────────

  /**
   * Recover a workflow run from its event log (deterministic replay).
   *
   * Loads all events for the given `run_id`, replays them through the same
   * pure reducers used during normal execution, and returns a GraphRunner
   * whose state is identical to the pre-crash state. The caller can then
   * invoke `.run()` to continue execution.
   *
   * During replay, **no LLM calls are made**. The stored `Action` objects
   * (which contain all agent outputs) are fed directly into the reducers.
   *
   * @param graph     The graph definition to execute against
   * @param runId     The workflow run_id to recover
   * @param eventLog  The event log writer to load events from
   * @param options   Optional persistence/graph loading functions
   * @returns         A GraphRunner ready to continue execution via `.run()`
   *
   * @throws Error if no events exist for the given run_id
   *
   * @example
   * ```ts
   * const runner = await GraphRunner.recover(graph, runId, eventLog, {
   *   persistStateFn: persistWorkflow,
   * });
   * const finalState = await runner.run(); // continues from where it left off
   * ```
   */
  static async recover(
    graph: Graph,
    runId: string,
    eventLog: EventLogWriter,
    options?: Omit<GraphRunnerOptions, 'eventLog'>,
  ): Promise<GraphRunner> {
    // Lazy import to break the runner → recover → runner cycle.
    const { recoverGraphRunner } = await import('./recover.js');
    return recoverGraphRunner(graph, runId, eventLog, options);
  }

  /**
   * @internal — only callable by `recoverGraphRunner`. Atomically applies a
   * recovered snapshot. Splitting these into three setters would let a
   * consumer observe a partially-recovered runner; this method is the
   * single rehydrate point so no intermediate state is visible.
   *
   * NOT a public API — do not call from application code. Future versions
   * may rename or remove this without a major bump.
   */
  _rehydrate(snapshot: {
    state: WorkflowState;
    executedActionIds: Array<{ nodeId: string; iterationCount: number }>;
    nextSequenceId: number;
  }): void {
    this.state = snapshot.state;
    for (const { nodeId, iterationCount } of snapshot.executedActionIds) {
      this.idempotency.add(nodeId, iterationCount);
    }
    this.sequenceId = snapshot.nextSequenceId;
  }

  /**
   * Compact the event log for the current run.
   *
   * Creates a checkpoint at the current sequence_id, then deletes all events
   * at or before that point. This reduces storage and speeds up future recovery.
   *
   * Should be called after a workflow completes, or periodically during
   * long-running workflows (e.g., every N iterations).
   *
   * @returns The number of events deleted
   *
   * @example
   * ```ts
   * const result = await runner.run();
   * const deleted = await runner.compactEvents();
   * logger.info('compacted', { deleted });
   * ```
   */
  async compactEvents(): Promise<number> {
    return this.persistence.compactNow(this.state, this.sequenceId);
  }

  /** Expose readonly access to the event log writer (for testing/diagnostics) */
  getEventLog(): EventLogWriter {
    return this.eventLog;
  }

  /**
   * Read-only view of the current workflow state.
   *
   * Used by callers that need to inspect a runner before/after execution —
   * e.g. the worker reconciles a recovered runner's progress against the
   * latest state snapshot. Treat the returned object as immutable.
   */
  getState(): Readonly<WorkflowState> {
    return this.state;
  }

}

/**
 * Human response payload for HITL (Human-in-the-Loop) resume.
 */
export interface HumanResponse {
  /** The reviewer's decision. */
  decision: 'approved' | 'rejected' | 'edited';
  /** Optional freeform response data. */
  data?: unknown;
  /** Optional memory updates to apply on resume. */
  memory_updates?: Record<string, unknown>;
}
