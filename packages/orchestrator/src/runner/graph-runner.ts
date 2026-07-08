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
import { BudgetExceededError, WorkflowTimeoutError, NoMatchingEdgeError } from './errors.js';
import { applyUsageAndEnforceBudgets, type ExecutionAccountingRuntime } from './execution-accounting.js';
import {
  incrementWorkflowsStarted,
  incrementWorkflowsCompleted,
  incrementWorkflowsFailed,
  recordWorkflowDuration,
  recordTokensUsed,
  recordCostUsd,
} from '../utils/metrics.js';
import type { EventLogWriter } from '../db/event-log.js';
import { NoopEventLogWriter } from '../db/event-log.js';
import { EventLogCoordinator } from './event-log-coordinator.js';
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
import type { SecurityPolicy } from './security-policy.js';
import { evaluateSecurityPolicy } from './security-policy.js';
import { computeHumanResponseOutcome, type HumanResponse } from './hitl-resume.js';

// Re-export for backward compatibility — HumanResponse moved to hitl-resume.ts
export type { HumanResponse } from './hitl-resume.js';

// Extracted modules
import { NodeExecutionDriver } from './node-execution-driver.js';
import type { NodeExecutorContext } from './node-executors/context.js';

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
  /** Emitted when the security policy reaches a non-`allow` decision for a node. */
  'security:policy': {
    run_id: string;
    node_id: string;
    effect: 'monitor' | 'block' | 'require_approval';
    sensitivity?: string[];
    tainted_keys: string[];
    reason?: string;
    rule_id?: string;
    timestamp: number;
  };
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
 * `eventLog` is wired and `compactionInterval` is not specified. Conservative
 * enough that short runs never compact, low enough that a long run's event log
 * stays bounded. Set `compactionInterval: 0` to opt out.
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
  autoRollback?: boolean;
  /**
   * When true, a node that is not a declared end node yet has no matching
   * outgoing edge silently completes the workflow (legacy behavior). When
   * false (default), the runner fails with `NoMatchingEdgeError` so a
   * dead-end (e.g. a typo'd edge condition) surfaces instead of producing a
   * misleading "completed" run that only executed part of the graph.
   */
  allowImplicitCompletion?: boolean;
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
  compactionInterval?: number;
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
  deltaTrackerOptions?: { fullSnapshotInterval?: number; maxPatchBytes?: number };
  /**
   * Optional taint-aware security policy consulted BEFORE each node executes.
   *
   * When provided, any node that reads untrusted (tainted) data is passed to
   * the policy, which may allow it, flag it (`monitor`), fail the run
   * (`block`), or pause it for human approval (`require_approval`) — without
   * the graph author wiring an approval node. See {@link SecurityPolicy}.
   */
  securityPolicy?: SecurityPolicy;
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
  /**
   * Runs one node to an Action: retry, circuit breaker, timeout/abort
   * arbitration, failed-attempt usage. See `runner/node-execution-driver.ts`.
   */
  private readonly driver: NodeExecutionDriver;
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

  // Event sourcing — durable execution. Sequence assignment, flush
  // barrier, failure tracking, and deferred appends are owned by the
  // coordinator; the runner keeps `eventLog` only for `getEventLog()`.
  private readonly eventLog: EventLogWriter;
  private readonly events: EventLogCoordinator;

  // Token streaming callback
  private onToken?: (token: string, nodeId: string) => void;

  // Middleware hooks
  private readonly middleware: GraphRunnerMiddleware[];

  // Tool resolver for structured ToolSource declarations (MCPConnectionManager)
  private readonly toolResolver?: ToolResolver;

  // Auto-rollback on failure (saga compensation)
  private readonly autoRollback: boolean;
  private readonly allowImplicitCompletion: boolean;

  // Routing options derived from the graph, forwarded to every getNextNode
  // call. `strict_taint` makes edge conditions that reference tainted memory
  // keys evaluate false, so a run never routes on untrusted data.
  private readonly routingOptions: { strict_taint: boolean };

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

  // Optional taint-aware security policy consulted before each node executes
  private readonly securityPolicy?: SecurityPolicy;

  // Auto-compaction: compact event log every N events (0 = disabled)
  private readonly compactionInterval: number;

  // Differential state persistence
  private readonly persistDeltaFn?: (patch: StatePatch) => Promise<void>;
  private readonly deltaTracker?: StateDeltaTracker;

  // Cancellation — allows external abort of in-flight agent/supervisor calls.
  // Per-NODE cancellation is owned by the NodeExecutionDriver.
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
  /** Live accessors handed to `applyUsageAndEnforceBudgets` each iteration. */
  private readonly accountingRuntime: ExecutionAccountingRuntime;
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
    this.events = new EventLogCoordinator({
      eventLog: this.eventLog,
      getRunId: () => this.state.run_id,
    });
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
    this.securityPolicy = options?.securityPolicy;
    this.autoRollback = options?.autoRollback ?? false;
    this.allowImplicitCompletion = options?.allowImplicitCompletion ?? false;
    this.compactionInterval = options?.compactionInterval ?? DEFAULT_COMPACTION_INTERVAL;
    this.persistDeltaFn = options?.persistDeltaFn;
    if (this.persistDeltaFn) {
      this.deltaTracker = new StateDeltaTracker(options?.deltaTrackerOptions);
    }

    // Build O(1) lookup structures (edgeMap shape owned by router.ts)
    this.nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    this.edgeMap = buildEdgeMap(graph);
    this.routingOptions = { strict_taint: graph.strict_taint === true };

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

    this.accountingRuntime = {
      getState: () => this.state,
      dispatchInternal: (type, payload) => this.dispatchInternal(type, payload),
      persistState: () => this.persistState(),
      drainPendingEvents: () => this.drainPendingEvents(),
      budget: this.budget,
    };

    // Wire the node execution driver with live accessors — `state`,
    // `startTime`, and `isStreaming` are reassigned during the run.
    this.driver = new NodeExecutionDriver({
      getGraph: () => this.graph,
      getState: () => this.state,
      getStartTime: () => this.startTime,
      isStreaming: () => this.isStreaming,
      getWorkflowAbortController: () => this.abortController,
      buildExecutorContext: () => this.buildExecutorContext(),
      dispatchInternal: (type, payload) => this.dispatchInternal(type, payload),
      emit: (event, payload) => this.emit(event, payload),
      pushPending: (event) => this.channel.pushPending(event),
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
    this.events.append('internal_dispatched', { internal_type: type, internal_payload: payload });
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
      get abortSignal() { return self.driver.nodeAbortSignal(); },
      get onToken() { return self.onToken; },
      get loadGraphFn() { return self.loadGraphFn; },
      get modelResolver() { return self.modelResolver; },
      get contextCompressor() { return self.contextCompressor; },
      get memoryRetriever() { return self.memoryRetriever; },
      get securityPolicy() { return self.securityPolicy; },
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
    const actionPromise = this.driver.executeWithTimeout(node);
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
   * Fail the run before any node executes (graph validation / wiring
   * errors): dispatch `_fail`, persist, and yield the terminal
   * `workflow:failed` event. Shared by the pre-flight checks in
   * {@link executeLoop}.
   */
  private async *failPreflight(logEvent: string, errorMsg: string): AsyncGenerator<StreamEvent> {
    logger.error(logEvent, new Error(errorMsg), { graph_id: this.graph.id });
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
      yield* this.failPreflight(
        'graph_validation_failed',
        `Graph validation failed: ${validation.errors.join(', ')}`,
      );
      return;
    }

    // Pre-flight wiring checks: catch missing runner dependencies BEFORE any
    // node runs, instead of failing mid-run after upstream nodes already spent
    // tokens (and, for some, being pointlessly retried).
    const wiring = this.checkRuntimeWiring();
    if (wiring.errors.length > 0) {
      yield* this.failPreflight(
        'runner_wiring_failed',
        `Runner wiring error: ${wiring.errors.join(', ')}`,
      );
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
      if (rebuild.maxSequenceId !== null) {
        this.events.advanceSequenceTo(rebuild.maxSequenceId + 1);
      }
      this.dispatchInternal('_init', { resume: true });
    } else {
      this.dispatchInternal('_init', { start_node: this.graph.start_node });
    }

    // Record events deferred from before execution (applyHumanResponse) —
    // sequenceId is now guaranteed past the run's existing log.
    this.events.replayDeferred();

    await this.persistState();
    yield* this.drainPendingEvents();

    // Log workflow_started event. Carries the reducer replay version so
    // recovery can detect logs written under different reducer semantics, plus
    // the run's limits/config — the event log is otherwise the ONLY record of
    // them, and crash recovery from the log (no checkpoint) would otherwise
    // resume with default limits (no token budget, max_iterations 50), silently
    // disabling budget/iteration/timeout enforcement post-recovery.
    this.events.append('workflow_started', {
      internal_payload: {
        replay_version: REPLAY_VERSION,
        config: {
          goal: this.state.goal,
          constraints: this.state.constraints,
          max_iterations: this.state.max_iterations,
          max_execution_time_ms: this.state.max_execution_time_ms,
          max_retries: this.state.max_retries,
          ...(this.state.max_token_budget !== undefined ? { max_token_budget: this.state.max_token_budget } : {}),
          ...(this.state.budget_usd !== undefined ? { budget_usd: this.state.budget_usd } : {}),
        },
      },
    });

    // The `workflow.run` span is established by run(); stream() consumers can
    // wrap their own consumption loop if they want a root span.
    try {
      while (shouldContinue(this.state) && !this.abortController.signal.aborted) {
        // Check global timeout
        if (this.checkTimeout()) {
          await this.persistState();
          yield* this.drainPendingEvents();

          const elapsedMs = Date.now() - (this.startTime ?? Date.now());
          this.lastRunError = new WorkflowTimeoutError(
            this.state.workflow_id,
            this.state.run_id,
            elapsedMs,
          );
          yield {
            type: 'workflow:timeout',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            elapsed_ms: elapsedMs,
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
          const skipNext = getNextNode(this.edgeMap, this.nodeMap, currentNode, this.state, this.routingOptions);
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
        this.events.append('node_started', { node_id: currentNode.id });

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

        // ── Security policy enforcement (taint-aware, pre-execution) ──
        // A node that reads untrusted data and performs a sensitive action is
        // gated/blocked HERE — before it runs — independent of how the graph
        // was authored. Skip approval nodes (they ARE a gate) and anything the
        // middleware already short-circuited. A `block` decision throws and is
        // handled by the run's failure path (fail-closed).
        let policyInjected = false;
        if (!action && this.securityPolicy && currentNode.type !== 'approval') {
          const gate = evaluateSecurityPolicy({
            node: currentNode,
            state: this.state,
            policy: this.securityPolicy,
            emitPolicyEvent: (payload) => this.emit('security:policy', payload),
          });
          if (gate) {
            action = gate;
            policyInjected = true;
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

            const durationMs = Date.now() - nodeStartTime;
            yield { type: 'node:complete', node_id: currentNode.id, node_type: currentNode.type, duration_ms: durationMs, timestamp: Date.now() };
            this.emit('node:complete', { node_id: currentNode.id, type: currentNode.type, duration_ms: durationMs });
          } else {
            // Node span + run context are established inside the driver's
            // executeWithTimeout, so both this branch and the streaming
            // branch above are covered uniformly.
            action = await this.driver.executeWithTimeout(currentNode);
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

        // Validate action against permissions. Policy-injected gates are
        // SYSTEM actions (not the node's own output), so they intentionally
        // bypass the node's write-key permission check.
        if (!policyInjected && !validateAction(action, currentNode.write_keys)) {
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
        this.events.append('action_dispatched', { node_id: currentNode.id, action });

        // Usage accounting + budget enforcement (tokens, cost, per-model
        // rollups, per-node budget, workflow token budget). Yields threshold
        // events; throws on breach. See runner/execution-accounting.ts.
        yield* applyUsageAndEnforceBudgets(action, currentNode, this.accountingRuntime);

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

        // Check if current node is an end node — if so, we're done. But a
        // flow-control action (approval node, or an injected security-policy
        // gate) may have paused the run at this node: a `waiting` end node is
        // held for human input, NOT complete. Only finalize a still-`running`
        // run; the pause is handled by the flow-control branch below.
        if (this.graph.end_nodes.includes(currentNode.id) && this.state.status === 'running') {
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
        let nextNode = getNextNode(this.edgeMap, this.nodeMap, currentNode, this.state, this.routingOptions);
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

      const durationMs = Date.now() - (this.startTime ?? Date.now());

      if (this.state.status === 'completed') {
        incrementWorkflowsCompleted({ graph_id: this.graph.id });
        recordWorkflowDuration(durationMs, { status: 'completed', graph_id: this.graph.id });
        recordTokensUsed(this.state.total_tokens_used, { graph_id: this.graph.id });
        if (this.state.total_cost_usd > 0) {
          recordCostUsd(this.state.total_cost_usd, { graph_id: this.graph.id });
        }
        this.emit('workflow:complete', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms: durationMs,
        });
        yield {
          type: 'workflow:complete',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms: durationMs,
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

      // Execute compensation actions if autoRollback is enabled and compensation stack is non-empty
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
      await this.events.flush().catch((error) => {
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
   * Apply human response and prepare for resumption.
   * Called by the worker before run() on HITL resume.
   */
  applyHumanResponse(response: HumanResponse): void {
    // Defer event appends until run()/stream() resumes: this method is
    // called before execution, when a freshly-constructed runner's
    // sequenceId hasn't been advanced past the run's existing event log yet.
    this.events.withDeferredAppends(() => this.applyHumanResponseInner(response));
  }

  private applyHumanResponseInner(response: HumanResponse): void {
    const outcome = computeHumanResponseOutcome(
      response,
      this.state,
      this.graph,
      this.edgeMap,
      this.nodeMap,
      this.routingOptions,
    );
    this.state = outcome.state;

    // Durably record the human decision BEFORE the follow-up dispatches, so
    // event-log replay applies the resume in the same order as the live run.
    // Without this, a recovered run would reconstruct state without the
    // human's response.
    this.events.append('action_dispatched', {
      node_id: outcome.resumeAction.metadata.node_id,
      action: outcome.resumeAction,
    });

    for (const dispatch of outcome.dispatches) {
      this.dispatchInternal(dispatch.type, dispatch.payload);
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

    const elapsedMs = Date.now() - this.startTime;

    if (elapsedMs > this.state.max_execution_time_ms) {
      logger.error('workflow_timeout', undefined, { elapsed_ms: elapsedMs, max_ms: this.state.max_execution_time_ms, run_id: this.state.run_id });
      this.dispatchInternal('_timeout');
      // When streaming, timeout events are yielded by executeLoop()
      if (!this.isStreaming) {
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsedMs,
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
    this.state = { ...this.state, _last_event_sequence_id: this.events.lastAssignedSequenceId };
    await this.events.flush();
    await this.persistence.persist(this.state, this.events.nextSequenceId);
  }

  // Node execution (retry / circuit breaker / timeout / abort linking)
  // lives in NodeExecutionDriver — see runner/node-execution-driver.ts.
  // Cost tracking lives in BudgetMonitor — see runner/budget-monitor.ts.

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
    this.events.advanceSequenceTo(snapshot.nextSequenceId);
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
    return this.persistence.compactNow(this.state, this.events.nextSequenceId);
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
