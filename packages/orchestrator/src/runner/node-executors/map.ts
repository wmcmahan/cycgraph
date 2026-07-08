/**
 * Map-Reduce Node Executor
 *
 * Fan-out: resolves an items array (from memory or static config),
 * spawns parallel worker nodes for each item, and collects results.
 *
 * @module runner/node-executors/map
 */

import { JSONPath } from 'jsonpath-plus';
import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { executeParallel, type ParallelTask } from '../parallel-executor.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { ensureSaveToMemory } from './agent.js';
import { NodeConfigError, UnsupportedNodeTypeError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { combineAbortSignals } from '../../utils/abort.js';
import { aggregateParallelTaint } from '../../utils/taint.js';

const logger = createLogger('runner.node.map');

/**
 * Execute a worker node with an explicit state view.
 *
 * Used by map-reduce to run each fan-out item against the worker
 * node. Unlike `executeNodeLogic`, this does **not** create a new
 * state view from the graph state — it uses the one provided.
 *
 * @param node - Worker node (must be `agent` or `tool`).
 * @param stateView - Pre-built state view with map-item metadata.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns Action produced by the worker.
 * @throws If the worker node type is not `agent` or `tool`.
 */
export async function executeWorkerWithStateView(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
  taskSignal?: AbortSignal,
): Promise<Action> {
  switch (node.type) {
    case 'agent': {
      const agent_id = node.agent_id;
      if (!agent_id) throw new NodeConfigError(node.id, 'agent', 'agent_id');
      const agentConfig = await ctx.deps.loadAgent(agent_id);
      const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), agent_id);
      const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, node.id) : undefined;
      // Combine the workflow signal with the per-task timeout signal so a
      // task_timeout_ms actually aborts the worker's LLM call.
      const abortSignal = combineAbortSignals(ctx.abortSignal, taskSignal);
      return ctx.deps.executeAgent(agent_id, stateView, tools, attempt, {
        node_id: node.id,
        abortSignal,
        onToken,
        drainTaintEntries: ctx.deps.drainTaintEntries,
        ...(node.default_write_key ? { default_write_key: node.default_write_key } : {}),
        ...buildAgentMemoryOptions(node, ctx),
      });
    }
    case 'tool': {
      const tool_id = node.tool_id;
      if (!tool_id) throw new NodeConfigError(node.id, 'tool', 'tool_id');
      // Resolve tool sources from node or agent config, then find the named tool
      const toolSources = node.tools ?? [];
      const resolvedTools = await ctx.deps.resolveTools(toolSources, node.agent_id);
      const toolDef = resolvedTools[tool_id] as { execute?: (args: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (!toolDef?.execute) {
        throw new NodeConfigError(node.id, 'tool', `resolvable tool "${tool_id}"`);
      }
      const raw = await toolDef.execute(stateView.memory);
      const resultKey = `${node.id}_result`;
      return {
        id: uuidv4(),
        idempotency_key: `${node.id}:map:${attempt}`,
        type: 'update_memory',
        payload: { updates: { [resultKey]: raw } },
        metadata: { node_id: node.id, timestamp: new Date(), attempt },
      };
    }
    default:
      throw new UnsupportedNodeTypeError(node.type);
  }
}

/**
 * Execute a map node: fan-out items to parallel workers.
 *
 * Items are resolved from `static_items` or via a JSONPath query
 * against the state view. Results are written to memory as
 * `<node_id>_results`, `<node_id>_errors`, and count fields.
 *
 * @param node - Map node with `map_reduce_config`.
 * @param stateView - Filtered state view.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `merge_parallel_results` action with collected outputs.
 * @throws If `map_reduce_config` is missing, no items source is specified, or worker node is not found.
 */
export async function executeMapNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.map_reduce_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'map', 'map_reduce_config');
  }

  logger.info('map_node_executing', { node_id: node.id, worker: config.worker_node_id });

  // Resolve items from static config or JSONPath
  let items: unknown[];
  if (config.static_items) {
    items = config.static_items;
  } else if (config.items_path) {
    try {
      const results = JSONPath({ path: config.items_path, json: stateView });
      items = Array.isArray(results[0]) ? results[0] : results;
    } catch {
      throw new NodeConfigError(node.id, 'map', `valid items_path ("${config.items_path}" failed)`);
    }
  } else {
    throw new NodeConfigError(node.id, 'map', 'static_items or items_path');
  }

  // Short-circuit on empty items
  if (items.length === 0) {
    logger.warn('map_empty_items', { node_id: node.id });
    return {
      id: uuidv4(),
      idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
      type: 'merge_parallel_results',
      payload: {
        updates: { [`${node.id}_results`]: [], [`${node.id}_count`]: 0 },
        total_tokens: 0,
      },
      metadata: { node_id: node.id, timestamp: new Date(), attempt },
    };
  }

  const workerNode = ctx.graph.nodes.find(n => n.id === config.worker_node_id);
  if (!workerNode) {
    throw new NodeConfigError(node.id, 'map', `worker node "${config.worker_node_id}"`);
  }

  const tasks: ParallelTask[] = items.map((item, index) => ({
    node: workerNode,
    stateView: {
      ...stateView,
      memory: {
        ...stateView.memory,
        _map_item: item,
        _map_index: index,
        _map_total: items.length,
      },
    },
    input_item: item,
    item_index: index,
  }));

  const results = await executeParallel(
    tasks,
    async (task, taskSignal) => executeWorkerWithStateView(task.node, task.stateView, 1, ctx, taskSignal),
    { max_concurrency: config.max_concurrency, error_strategy: config.error_strategy, task_timeout_ms: config.task_timeout_ms },
  );

  const successResults = results.filter(r => r.success).map(r => ({
    index: r.task_index,
    node_id: r.node_id,
    updates: r.action?.payload?.updates,
  }));
  const errorResults = results.filter(r => !r.success).map(r => ({
    index: r.task_index,
    node_id: r.node_id,
    error: r.error,
  }));

  // Sum input/output tokens separately from each worker action so the
  // runner's cost-tracking path can derive cost. Capture the model from
  // the first worker — every worker runs the same agent so it's uniform.
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let observedModel: string | undefined;
  for (const r of results) {
    const usage = r.action?.metadata.token_usage;
    if (!usage) continue;
    totalInputTokens += usage.inputTokens ?? 0;
    totalOutputTokens += usage.outputTokens ?? 0;
    totalTokens += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    if (!observedModel && typeof r.action?.metadata.model === 'string') {
      observedModel = r.action.metadata.model;
    }
  }

  // Re-surface worker taint: any tainted worker output is buried under
  // `${node.id}_results`, so mark the aggregate keys tainted in the parent
  // registry (mergeMemory treats `_taint_registry` append-only).
  const aggregateKeys = [
    `${node.id}_results`,
    `${node.id}_errors`,
    `${node.id}_count`,
    `${node.id}_error_count`,
  ];
  const taintUpdates = aggregateParallelTaint(
    successResults.map(r => r.updates as Record<string, unknown> | undefined),
    aggregateKeys,
    node.id,
  );

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'merge_parallel_results',
    payload: {
      updates: {
        [`${node.id}_results`]: successResults,
        [`${node.id}_errors`]: errorResults,
        [`${node.id}_count`]: successResults.length,
        [`${node.id}_error_count`]: errorResults.length,
        ...(Object.keys(taintUpdates).length > 0
          ? { _taint_registry: taintUpdates }
          : {}),
      },
      total_tokens: totalTokens,
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      ...(observedModel ? { model: observedModel } : {}),
      token_usage: {
        totalTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    },
  };
}
