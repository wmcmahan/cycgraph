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
import { rootReducer, internalReducer, validateAction } from '../reducers/index.js';
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
import { BudgetExceededError, WorkflowTimeoutError, NodeConfigError, CircuitBreakerOpenError, EventLogCorruptionError, UnsupportedNodeTypeError } from './errors.js';
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
import { PermissionDeniedError } from '../agent/agent-executor/errors.js';

// Extracted modules
import { CircuitBreakerManager } from './circuit-breaker.js';
import { createStateView } from './state-view.js';
import type { NodeExecutorContext } from './node-executors/context.js';
import {
  executeAgentNode,
  executeToolNode,
  executeRouterNode,
  executeSupervisorNode,
  executeApprovalNode,
  executeMapNode,
  executeVotingNode,
  executeSynthesizerNode,
  executeSubgraphNode,
  executeEvolutionNode,
} from './node-executors/index.js';

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
   * Number of events between automatic event log compactions.
   *
   * When set (and an `eventLog` is provided), the runner will
   * automatically checkpoint and compact the event log every N events.
   * This prevents unbounded event log growth in long-running workflows.
   *
   * Set to 0 or omit to disable auto-compaction (manual only via `compactEvents()`).
   * @default 0 (disabled)
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

  // Budget-aware model resolver (optional)
  private readonly modelResolver?: ModelResolver;

  // Context compressor for memory in prompts (optional)
  private readonly contextCompressor?: ContextCompressor;

  // Memory retriever for injecting relevant facts into prompts (optional)
  private readonly memoryRetriever?: MemoryRetriever;

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
    this.autoRollback = options?.auto_rollback ?? false;
    this.compactionInterval = options?.compaction_interval ?? 0;
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

  // Event log failure tracking for observability
  private eventLogFailures: number = 0;

  /**
   * Append an event to the durable event log.
   * Fire-and-forget — failures are logged but never halt the workflow.
   * Errors are caught to prevent unhandled promise rejections and tracked
   * via a failure counter for observability.
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
    const event = {
      run_id: this.state.run_id,
      sequence_id: this.sequenceId++,
      event_type,
      ...opts,
    };
    // Intentionally not awaited — event log is best-effort alongside
    // the primary state snapshot path.
    this.eventLog.append(event).catch((error) => {
      this.eventLogFailures++;
      logger.error('event_log_append_failed', error, {
        run_id: this.state.run_id,
        sequence_id: event.sequence_id,
        event_type,
        consecutive_failures: this.eventLogFailures,
      });
    });
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
      this.dispatchInternal('_init', { resume: true });
      const rebuild = await this.idempotency.rebuildFromEventLog(
        this.eventLog,
        this.state.run_id,
        this.state.iteration_count,
      );
      // The tracker doesn't own sequenceId — advance it ourselves so the event
      // log stays continuous after replay.
      if (rebuild.maxSequenceId !== null) {
        this.sequenceId = rebuild.maxSequenceId + 1;
      }
    } else {
      this.dispatchInternal('_init', { start_node: this.graph.start_node });
    }
    await this.persistState();
    yield* this.drainPendingEvents();

    // Log workflow_started event (first event in the event log for this run)
    this.appendEvent('workflow_started');

    const workflowSpan = { setAttribute: (_k: string, _v: unknown) => {} };
    try {
      // Get a real span if tracing is available
      const realTracer = getTracer('orchestrator.runner');
      void realTracer; // span wrapping handled via withSpan pattern in run()
    } catch { /* noop */ }

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
            action = await withSpan(tracer, `node.execute.${currentNode.type}`, async (nodeSpan) => {
              nodeSpan.setAttribute('node.id', currentNode.id);
              nodeSpan.setAttribute('node.type', currentNode.type);
              return this.executeNodeWithTimeout(currentNode);
            });
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

        // Check idempotency using monotonically increasing sequence ID (unique per action)
        if (this.idempotency.has(currentNode.id, this.sequenceId)) {
          logger.warn('duplicate_action', { idempotency_key: `${currentNode.id}:${this.sequenceId}`, node_id: currentNode.id });
          continue;
        }

        // Mark as executed
        this.idempotency.add(currentNode.id, this.sequenceId);

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

        // Track cumulative cost from token usage
        if (tokenUsage?.inputTokens !== undefined || tokenUsage?.outputTokens !== undefined) {
          const inputTokens = tokenUsage.inputTokens ?? 0;
          const outputTokens = tokenUsage.outputTokens ?? 0;
          const costUsd = this.budget.calculateActionCost(inputTokens, outputTokens, action);
          if (costUsd > 0) {
            this.dispatchInternal('_track_cost', { cost_usd: costUsd });
            await this.budget.checkThresholds(this.state);
            yield* this.drainPendingEvents();
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

        // Determine next node from outgoing edges
        let nextNode = getNextNode(this.edgeMap, this.nodeMap, currentNode, this.state);
        if (!nextNode) {
          logger.info('execution_complete', { graph_id: this.graph.id, run_id: this.state.run_id });
          this.dispatchInternal('_complete');
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
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
      for await (const _event of this.executeLoop()) {
        // Drain all events — run() consumes but discards them
      }
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

        // Update circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.update(node.id, false, this.graph.nodes);
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

    switch (node.type) {
      case 'agent':
        return await executeAgentNode(node, stateView, attempt, ctx);
      case 'tool':
        return await executeToolNode(node, stateView, attempt, ctx);
      case 'router':
        return await executeRouterNode(node, stateView, attempt, ctx);
      case 'supervisor':
        return await executeSupervisorNode(node, stateView, attempt, ctx);
      case 'approval':
        return await executeApprovalNode(node, stateView, attempt, ctx);
      case 'map':
        return await executeMapNode(node, stateView, attempt, ctx);
      case 'voting':
        return await executeVotingNode(node, stateView, attempt, ctx);
      case 'synthesizer':
        return await executeSynthesizerNode(node, stateView, attempt, ctx);
      case 'subgraph':
        return await executeSubgraphNode(node, stateView, attempt, ctx);
      case 'evolution':
        return await executeEvolutionNode(node, stateView, attempt, ctx);
      default:
        throw new UnsupportedNodeTypeError(node.type);
    }
  }

  /**
   * Apply human response and prepare for resumption.
   * Called by the worker before run() on HITL resume.
   */
  applyHumanResponse(response: HumanResponse): void {
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
   */
  private async persistState(): Promise<void> {
    await this.persistence.persist(this.state, this.sequenceId);
  }

  /**
   * Reconstruct idempotency keys from persisted state on resume.
   * Only completed iterations (0 through iteration_count-1) are reconstructed.
   * The current iteration has NOT completed and must be re-executed.
   */
  /**
   * Validate event log integrity on resume.
   *
   * Checks for:
   * - Monotonically increasing sequence IDs with no gaps
   * - First event is `workflow_started`
   * - Event count is consistent with iteration_count
   *
   * Throws {@link EventLogCorruptionError} if corruption is detected.
   * Silently succeeds if no events exist (event log may be noop).
   */
  private async validateEventLogIntegrity(): Promise<void> {
    try {
      const events = await this.eventLog.loadEvents(this.state.run_id);

      // No events is OK — event log may be a NoopEventLogWriter
      if (events.length === 0) return;

      // Check that first event is workflow_started
      if (events[0].event_type !== 'workflow_started') {
        logger.error('event_log_integrity_failed', new Error('Missing workflow_started event'), {
          first_event_type: events[0].event_type,
          run_id: this.state.run_id,
        });
        throw new EventLogCorruptionError(this.state.run_id);
      }

      // Check monotonically increasing sequence IDs with no gaps
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1].sequence_id;
        const curr = events[i].sequence_id;
        if (curr !== prev + 1) {
          logger.error('event_log_integrity_failed', new Error('Sequence gap detected'), {
            expected_sequence: prev + 1,
            actual_sequence: curr,
            run_id: this.state.run_id,
          });
          throw new EventLogCorruptionError(this.state.run_id);
        }
      }
    } catch (error) {
      if (error instanceof EventLogCorruptionError) throw error;
      // loadEvents failed — log but don't block resume
      logger.warn('event_log_integrity_check_skipped', {
        error: error instanceof Error ? error.message : String(error),
        run_id: this.state.run_id,
      });
    }
  }

  /**
   * Execute node with timeout wrapper.
   * Uses AbortController to ensure the timeout handle is always cleaned up,
   * preventing timer leaks when the node completes before the timeout fires.
   */
  private async executeNodeWithTimeout(node: GraphNode): Promise<Action> {
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
