/**
 * Node Execution Driver
 *
 * Owns "run one node to an Action": retry with backoff, circuit-breaker
 * checks, node-vs-workflow timeout arbitration, per-node abort linking,
 * failed-attempt usage accounting, node lifecycle events (in
 * non-streaming mode), and dispatch to the node-executor registry.
 *
 * The driver holds the per-node AbortController: a NODE-level timeout
 * aborts only this node's in-flight work instead of poisoning parallel
 * siblings via the shared workflow controller. A WORKFLOW-level timeout
 * still aborts the shared controller (the whole run is over).
 * {@link NodeExecutionDriver.nodeAbortSignal} combines both for the
 * signal handed to node executors.
 *
 * @module runner/node-execution-driver
 */

import type { Graph, GraphNode } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import type { NodeExecutorContext } from './node-executors/context.js';
import type { StreamEvent } from './stream-events.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { createStateView } from './state-view.js';
import { getNodeExecutor } from './node-executors/index.js';
import { calculateBackoff, sleep } from './helpers.js';
import { WorkflowTimeoutError, UnsupportedNodeTypeError } from './errors.js';
import { calculateCost } from '../utils/pricing.js';
import { createLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/context.js';
import { getTracer, withSpan } from '../utils/tracing.js';

const logger = createLogger('runner.node-execution-driver');
const tracer = getTracer('orchestrator.runner');

/** Constructor dependencies — live accessors into the owning runner. */
export interface NodeExecutionDriverDeps {
  getGraph: () => Graph;
  getState: () => WorkflowState;
  /** The runner's run start time (undefined before execution begins). */
  getStartTime: () => number | undefined;
  /** True when the runner is in `stream()` mode (lifecycle events are yielded there instead). */
  isStreaming: () => boolean;
  /** The shared workflow AbortController — aborted on workflow-level timeout. */
  getWorkflowAbortController: () => AbortController;
  /** Build the executor context bag (owned by the runner — wires channel, deps, etc.). */
  buildExecutorContext: () => NodeExecutorContext;
  /** Dispatch a trusted internal action (usage tracking on failed attempts). */
  dispatchInternal: (type: string, payload?: Record<string, unknown>) => void;
  /** EventEmitter passthrough — `runner.emit`. */
  emit: (
    event: 'node:start' | 'node:complete' | 'node:failed' | 'node:retry',
    payload: Record<string, unknown>,
  ) => void;
  /** Push a stream event (retry notifications while streaming). */
  pushPending: (event: StreamEvent) => void;
}

/**
 * Per-runner node execution pipeline. One instance per `GraphRunner`
 * lifetime — the circuit-breaker state spans the whole run.
 */
export class NodeExecutionDriver {
  private readonly circuitBreakers = new CircuitBreakerManager();

  // Per-node cancellation. Linked to the workflow signal via
  // `nodeAbortSignal()`, so a workflow-level cancel/timeout still
  // cascades into the node.
  private currentNodeAbortController?: AbortController;

  constructor(private readonly deps: NodeExecutionDriverDeps) {}

  /**
   * The abort signal handed to node execution: the workflow controller and the
   * current per-node controller (if any) combined, so EITHER a workflow-level
   * cancel/timeout OR a node-level timeout cancels the node's in-flight calls.
   */
  nodeAbortSignal(): AbortSignal {
    const workflowSignal = this.deps.getWorkflowAbortController().signal;
    const nodeSignal = this.currentNodeAbortController?.signal;
    if (!nodeSignal || workflowSignal.aborted) return workflowSignal;
    if (nodeSignal.aborted) return nodeSignal;
    return AbortSignal.any([workflowSignal, nodeSignal]);
  }

  /**
   * Execute a node with the timeout wrapper — the driver's entry point.
   *
   * Re-establishes run context here: under `stream()`, an external consumer
   * drives the generator outside run()'s runWithContext scope, so this
   * per-node chokepoint is where node/agent/MCP logs pick up run_id. The
   * node.execute span also lives here so BOTH the streaming and
   * non-streaming paths produce it.
   */
  async executeWithTimeout(node: GraphNode): Promise<Action> {
    const state = this.deps.getState();
    return runWithContext(
      { run_id: state.run_id, graph_id: this.deps.getGraph().id },
      () => withSpan(tracer, `node.execute.${node.type}`, (nodeSpan) => {
        nodeSpan.setAttribute('node.id', node.id);
        nodeSpan.setAttribute('node.type', node.type);
        nodeSpan.setAttribute('workflow.run_id', state.run_id);
        return this.executeWithTimeoutInner(node);
      }),
    );
  }

  /**
   * Timeout arbitration. Uses AbortController + clearTimeout in `finally`
   * so the timeout handle is always cleaned up, preventing timer leaks when
   * the node completes before the timeout fires.
   */
  private async executeWithTimeoutInner(node: GraphNode): Promise<Action> {
    const nodeTimeout = node.failure_policy.timeout_ms;
    const state = this.deps.getState();
    const startTime = this.deps.getStartTime();

    // Calculate remaining workflow-level timeout
    let workflowTimeoutMs: number | undefined;
    if (startTime && state.max_execution_time_ms) {
      const elapsed = Date.now() - startTime;
      const remaining = state.max_execution_time_ms - elapsed;
      if (remaining <= 0) {
        // Already past deadline
        this.deps.getWorkflowAbortController().abort();
        throw new WorkflowTimeoutError(state.workflow_id, state.run_id, elapsed);
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

    // Establish a per-node controller for the duration of this node so a
    // NODE-level timeout cancels only this node's in-flight LLM calls.
    // Save/restore keeps this correct if nodes ever nest.
    const nodeAbort = new AbortController();
    const prevNodeAbort = this.currentNodeAbortController;
    this.currentNodeAbortController = nodeAbort;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (isWorkflowTimeout) {
            // Whole run is past deadline — abort the workflow controller.
            this.deps.getWorkflowAbortController().abort();
            const elapsed = Date.now() - (startTime ?? Date.now());
            reject(new WorkflowTimeoutError(state.workflow_id, state.run_id, elapsed));
          } else {
            // Only this node timed out — cancel its work, leave the workflow
            // controller (and any parallel siblings) untouched.
            nodeAbort.abort();
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
      this.currentNodeAbortController = prevNodeAbort;
    }
  }

  /**
   * Execute a single node with retry logic.
   *
   * When streaming, node lifecycle events (start/complete/failed) are
   * emitted by the runner's executeLoop instead to avoid double-emission.
   */
  private async executeNode(node: GraphNode): Promise<Action> {
    const nodeStartTime = Date.now();

    if (!this.deps.isStreaming()) {
      this.deps.emit('node:start', {
        node_id: node.id,
        type: node.type,
        timestamp: nodeStartTime,
      });
    }

    try {
      // Execute with retry
      const action = await this.executeNodeWithRetry(node);

      const durationMs = Date.now() - nodeStartTime;

      if (!this.deps.isStreaming()) {
        this.deps.emit('node:complete', {
          node_id: node.id,
          type: node.type,
          duration_ms: durationMs,
        });
      }

      return action;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (!this.deps.isStreaming()) {
        this.deps.emit('node:failed', {
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
      this.deps.dispatchInternal('_track_tokens', {
        tokens: totalTokens,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
      });
    }
    if (usage.model && (usage.inputTokens || usage.outputTokens)) {
      const cost = calculateCost(usage.model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
      if (cost > 0) {
        this.deps.dispatchInternal('_track_cost', { cost_usd: cost });
      }
      this.deps.dispatchInternal('_track_model_usage', {
        model: usage.model,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        cost_usd: cost,
      });
    }
  }

  /** Execute node with retry and circuit breaker. */
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
          this.circuitBreakers.update(node.id, true, this.deps.getGraph().nodes);
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
          this.circuitBreakers.update(node.id, false, this.deps.getGraph().nodes);
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

        const isLastAttempt = attempt === policy.max_retries;
        if (isLastAttempt) break;

        // Calculate backoff and retry
        const backoffMs = calculateBackoff(
          attempt,
          policy.backoff_strategy,
          policy.initial_backoff_ms,
          policy.max_backoff_ms
        );

        this.deps.emit('node:retry', { node_id: node.id, attempt, backoff_ms: backoffMs });
        if (this.deps.isStreaming()) {
          this.deps.pushPending({
            type: 'node:retry',
            node_id: node.id,
            attempt,
            backoff_ms: backoffMs,
            timestamp: Date.now(),
          });
        }
        logger.warn('node_retry', { node_id: node.id, attempt, backoff_ms: backoffMs, error: lastError?.message });

        await sleep(backoffMs);
      }
    }

    throw lastError || new Error(`Node ${node.id} failed after ${policy.max_retries} retries`);
  }

  /**
   * Execute node logic based on type — dispatches to extracted executor functions.
   */
  private async executeNodeLogic(node: GraphNode, attempt: number): Promise<Action> {
    // Create state view (security boundary)
    const stateView = createStateView(this.deps.getState(), node);
    const ctx = this.deps.buildExecutorContext();

    // Dispatch via the node-executor registry (a compiler-exhaustive
    // Record<NodeType, NodeExecutor>) instead of a hand-maintained switch.
    const executor = getNodeExecutor(node.type);
    if (!executor) {
      throw new UnsupportedNodeTypeError(node.type);
    }
    return await executor(node, stateView, attempt, ctx);
  }
}
