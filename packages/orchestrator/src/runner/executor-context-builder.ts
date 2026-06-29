/**
 * Executor Context Builder
 *
 * Constructs the `NodeExecutorContext` bundle passed to every node executor.
 * Closures inside the context (onToken, onToolCall, etc.) read mutable fields
 * on the supplied runner reference — `runner.state`, `runner.isStreaming`,
 * `runner.tokenChannel` — at call time, so a context built at the start of a
 * node's execution stays correct even as state evolves.
 *
 * Design note: the runner type is intentionally narrow (only fields we touch).
 * Anything broader leaks coupling. This module never reads the runner's
 * private internals — it accesses public-shaped fields only.
 *
 * @module runner/executor-context-builder
 */

import type { Graph, GraphNode } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import type { StreamEvent } from './stream-events.js';
import type { NodeExecutorContext } from './node-executors/context.js';
import type { ToolResolver } from '../mcp/connection-manager.js';
import type { ModelResolver } from '../agent/model-resolver.js';
import type { ContextCompressor } from '../agent/context-compressor.js';
import type { MemoryRetriever } from '../agent/memory-retriever.js';
import type { SecurityPolicy } from './security-policy.js';
import type { MemoryWriter } from '../agent/memory-writer.js';
import type { FactSanitizer } from '../agent/fact-sanitizer.js';
import type { FitnessFunction } from '../agent/fitness-function.js';
import type { RateLimiter } from '../agent/rate-limiter.js';
import { createStateView } from './state-view.js';
import { executeAgent } from '../agent/agent-executor/executor.js';
import { executeSupervisor } from '../agent/supervisor-executor/executor.js';
import { evaluateQualityExecutor } from '../agent/evaluator-executor/executor.js';
import { extractFactsExecutor } from '../agent/extractor-executor/executor.js';
import { agentFactory } from '../agent/agent-factory/index.js';
import { getTaintRegistry } from '../utils/taint.js';
import { resolveBuiltinsOnly } from './fallback-tool-resolver.js';

/**
 * Narrow view of the runner required by {@link buildExecutorContext}.
 *
 * Closures resolve fields on this reference at call time — do NOT pre-extract
 * values. `runner.state` is mutated by every reducer; capturing it as a value
 * here would break token streaming when the run_id is read later.
 */
export interface ExecutorContextRunner {
  readonly graph: Graph;
  state: WorkflowState;
  isStreaming: boolean;
  tokenChannel: StreamEvent[];
  tokenNotify?: () => void;
  abortSignal: AbortSignal;

  onToken?: (token: string, nodeId: string) => void;
  loadGraphFn?: (graphId: string) => Promise<Graph | null>;
  modelResolver?: ModelResolver;
  contextCompressor?: ContextCompressor;
  memoryRetriever?: MemoryRetriever;
  memoryWriter?: MemoryWriter;
  factSanitizer?: FactSanitizer;
  factSanitizerFailMode?: 'drop' | 'pass';
  fitnessFunction?: FitnessFunction;
  rateLimiter?: RateLimiter;
  toolResolver?: ToolResolver;
  securityPolicy?: SecurityPolicy;

  emit(event: string, payload: unknown): boolean;
  listenerCount(event: string | symbol): number;
}

/**
 * Build the {@link NodeExecutorContext} for the next node execution.
 *
 * Called once per node-execution (the runner does this in `executeNodeLogic`).
 * Within the returned context, every callback that touches state does so
 * through the supplied `runner` reference — late-mutated fields like
 * `isStreaming` or `state.run_id` resolve correctly at call time.
 */
export function buildExecutorContext(runner: ExecutorContextRunner): NodeExecutorContext {
  const rateLimiter = runner.rateLimiter;

  // Enable token streaming when there are event listeners (SSE bridge),
  // an explicit onToken callback was provided, or stream() is active.
  const shouldStream =
    runner.isStreaming || !!runner.onToken || runner.listenerCount('agent:token_delta') > 0;

  const onToken = shouldStream
    ? (token: string, nodeId: string) => {
      runner.emit('agent:token_delta', {
        run_id: runner.state.run_id,
        node_id: nodeId,
        token,
      });
      runner.onToken?.(token, nodeId);

      if (runner.isStreaming) {
        runner.tokenChannel.push({
          type: 'agent:token_delta',
          run_id: runner.state.run_id,
          node_id: nodeId,
          token,
          timestamp: Date.now(),
        });
        runner.tokenNotify?.();
      }
    }
    : undefined;

  const onToolCall = (event: { toolName: string; toolCallId: string; args: unknown }, nodeId: string) => {
    const streamEvent: StreamEvent = {
      type: 'tool:call_start',
      run_id: runner.state.run_id,
      node_id: nodeId,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      args: event.args,
      timestamp: Date.now(),
    };
    runner.emit('tool:call_start', streamEvent);
    if (runner.isStreaming) {
      runner.tokenChannel.push(streamEvent);
      runner.tokenNotify?.();
    }
  };

  const onToolCallComplete = (
    event: { toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string },
    nodeId: string,
  ) => {
    const streamEvent: StreamEvent = {
      type: 'tool:call_finish',
      run_id: runner.state.run_id,
      node_id: nodeId,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      duration_ms: event.durationMs,
      success: event.success,
      ...(event.error ? { error: event.error } : {}),
      timestamp: Date.now(),
    };
    runner.emit('tool:call_finish', streamEvent);
    if (runner.isStreaming) {
      runner.tokenChannel.push(streamEvent);
      runner.tokenNotify?.();
    }
  };

  // Static snapshot of remaining budget at the moment the context is built.
  // Executors that need a fresh value should call `getRemainingBudgetUsd()`
  // (closure below) instead — it reads `runner.state` at call time.
  const remainingBudgetUsd = (runner.state.budget_usd && runner.state.budget_usd > 0)
    ? Math.max(0, runner.state.budget_usd - (runner.state.total_cost_usd ?? 0))
    : undefined;

  return {
    state: runner.state,
    graph: runner.graph,
    loadGraphFn: runner.loadGraphFn,
    toolResolver: runner.toolResolver,
    createStateView: (node: GraphNode) => createStateView(runner.state, node),
    abortSignal: runner.abortSignal,
    modelResolver: runner.modelResolver,
    contextCompressor: runner.contextCompressor,
    memoryRetriever: runner.memoryRetriever,
    securityPolicy: runner.securityPolicy,
    memoryWriter: runner.memoryWriter,
    factSanitizer: runner.factSanitizer,
    factSanitizerFailMode: runner.factSanitizerFailMode,
    fitnessFunction: runner.fitnessFunction,
    rateLimiter,
    remainingBudgetUsd,
    getRemainingBudgetUsd: () => {
      return (runner.state.budget_usd && runner.state.budget_usd > 0)
        ? Math.max(0, runner.state.budget_usd - (runner.state.total_cost_usd ?? 0))
        : undefined;
    },
    onToken,
    onToolCall,
    onToolCallComplete,
    onContextCompressed: (event, nodeId) => {
      const streamEvent: StreamEvent = {
        type: 'context:compressed',
        run_id: runner.state.run_id,
        node_id: nodeId,
        tokens_in: event.tokensIn,
        tokens_out: event.tokensOut,
        reduction_percent: event.reductionPercent,
        duration_ms: event.durationMs,
        timestamp: Date.now(),
      };
      runner.emit('context:compressed', streamEvent);
      if (runner.isStreaming) {
        runner.tokenChannel.push(streamEvent);
        runner.tokenNotify?.();
      }
    },
    onModelResolved: (event, nodeId) => {
      const streamEvent: StreamEvent = {
        type: 'model:resolved',
        run_id: runner.state.run_id,
        node_id: nodeId,
        agent_id: event.agentId,
        reason: event.resolution.reason,
        resolved_model: event.resolution.model,
        original_model: event.originalModel,
        preference: (() => {
          switch (event.resolution.reason) {
            case 'preferred': return event.resolution.tier;
            case 'budget_downgrade': return event.resolution.original_tier;
            case 'budget_critical': return event.resolution.original_tier;
          }
        })(),
        remaining_budget_usd: remainingBudgetUsd,
        timestamp: Date.now(),
      };
      runner.emit('model:resolved', streamEvent);
      if (runner.isStreaming) {
        runner.tokenChannel.push(streamEvent);
        runner.tokenNotify?.();
      }
    },
    deps: {
      // Wrap the LLM-call deps so an injected rate limiter is awaited before
      // every agent/supervisor/evaluator call — one chokepoint instead of
      // threading the limiter through all seven call sites. No-op (zero wrap
      // overhead) when no limiter is configured.
      executeAgent: rateLimiter
        ? (agentId, stateView, tools, attempt, options) =>
            rateLimiter(
              { agentId, kind: 'agent', ...(options?.node_id ? { nodeId: options.node_id } : {}) },
              { abortSignal: runner.abortSignal },
            ).then(() => executeAgent(agentId, stateView, tools, attempt, options))
        : executeAgent,
      executeSupervisor: rateLimiter
        ? (node, stateView, history, attempt, options) =>
            rateLimiter(
              { agentId: node.agent_id ?? node.id, kind: 'supervisor', nodeId: node.id },
              { abortSignal: runner.abortSignal },
            ).then(() => executeSupervisor(node, stateView, history, attempt, options))
        : executeSupervisor,
      evaluateQualityExecutor: rateLimiter
        ? (evaluatorAgentId, goal, data, instruction) =>
            rateLimiter(
              { agentId: evaluatorAgentId, kind: 'evaluator' },
              { abortSignal: runner.abortSignal },
            ).then(() => evaluateQualityExecutor(evaluatorAgentId, goal, data, instruction))
        : evaluateQualityExecutor,
      extractFactsExecutor,
      loadAgent: (agentId: string) => agentFactory.loadAgent(agentId),
      getTaintRegistry,
      resolveTools: runner.toolResolver
        ? (sources, agentId) => runner.toolResolver!.resolveTools(sources, agentId)
        : resolveBuiltinsOnly,
      drainTaintEntries: runner.toolResolver?.drainTaintEntries
        ? (tools?: Record<string, unknown>) => runner.toolResolver!.drainTaintEntries!(tools)
        : undefined,
    },
  };
}
