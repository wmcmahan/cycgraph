/**
 * Subgraph Node Executor
 *
 * Executes a nested workflow (subgraph) as a single node. Memory is
 * mapped between parent and child scopes via `input_mapping` and
 * `output_mapping`. Includes cycle detection to prevent infinite
 * subgraph recursion.
 *
 * @module runner/node-executors/subgraph
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, WorkflowState, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.subgraph');

/**
 * Maximum nesting depth for subgraphs. Cycle detection only blocks revisiting
 * the SAME subgraph id; a chain of DISTINCT subgraphs (g1 → g2 → … → gN) would
 * otherwise recurse until native stack/heap exhaustion (DoS). 32 is far beyond
 * any legitimate composition depth.
 */
const MAX_SUBGRAPH_DEPTH = 32;

/**
 * Execute a subgraph node (nested workflow composition).
 *
 * Builds an isolated child state, runs a new {@link GraphRunner}
 * instance, and maps the child's output memory back to the parent.
 *
 * @param node - Subgraph node with `subgraph_config`.
 * @param stateView - Filtered state view from the parent workflow.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context (must include `loadGraphFn`).
 * @returns `update_memory` action with mapped child outputs.
 * @throws If `subgraph_config` is missing, `loadGraphFn` is not provided,
 *         the subgraph is not found, or a subgraph cycle is detected.
 */
export async function executeSubgraphNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.subgraph_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'subgraph', 'subgraph_config');
  }

  if (!ctx.loadGraphFn) {
    throw new NodeConfigError(node.id, 'subgraph', 'loadGraphFn');
  }

  logger.info('subgraph_executing', { node_id: node.id, subgraph_id: config.subgraph_id });

  // Cycle detection: prevent A → B → A recursion.
  const subgraphStack = (ctx.state.memory._subgraph_stack as string[]) ?? [];
  if (subgraphStack.includes(config.subgraph_id)) {
    throw new NodeConfigError(node.id, 'subgraph', `non-cyclic graph (cycle: ${[...subgraphStack, config.subgraph_id].join(' -> ')})`);
  }

  // Depth cap: a chain of distinct subgraphs passes cycle detection but can
  // still recurse without bound. Refuse beyond MAX_SUBGRAPH_DEPTH.
  if (subgraphStack.length >= MAX_SUBGRAPH_DEPTH) {
    throw new NodeConfigError(
      node.id,
      'subgraph',
      `subgraph nesting within depth limit (${MAX_SUBGRAPH_DEPTH}); current chain: ${[...subgraphStack, config.subgraph_id].join(' -> ')}`,
    );
  }

  const childGraph = await ctx.loadGraphFn(config.subgraph_id);
  if (!childGraph) {
    throw new NodeConfigError(node.id, 'subgraph', `graph "${config.subgraph_id}"`);
  }

  // Build isolated child memory with mapped inputs
  const childMemory: Record<string, unknown> = {
    _subgraph_stack: [...subgraphStack, ctx.graph.id],
  };
  for (const [parentKey, childKey] of Object.entries(config.input_mapping)) {
    if (parentKey in stateView.memory) {
      childMemory[childKey] = stateView.memory[parentKey];
    }
  }

  const remainingBudget = ctx.state.max_token_budget
    ? ctx.state.max_token_budget - ctx.state.total_tokens_used
    : undefined;

  const childState: WorkflowState = {
    state_schema_version: 1,
    workflow_id: config.subgraph_id,
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: stateView.goal,
    constraints: stateView.constraints,
    status: 'pending',
    current_node: undefined,
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    last_error: undefined,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    started_at: undefined,
    max_execution_time_ms: 3_600_000,
    memory: childMemory,
    total_tokens_used: 0,
    total_cost_usd: 0,
    max_token_budget: remainingBudget,
    visited_nodes: [],
    max_iterations: config.max_iterations,
    compensation_stack: [],
    supervisor_history: [],
    memory_drops: [],
    _cost_alert_thresholds_fired: [],
  };

  // Lazy import to avoid circular dependency (GraphRunner → subgraph → GraphRunner)
  const { GraphRunner } = await import('../graph-runner.js');

  // Propagate the parent's guardrails into the child runner. Without this a
  // subgraph silently runs with NO toolResolver (built-ins only), NO
  // factSanitizer (PII redaction off), NO memoryWriter (reflection nodes
  // throw), and ignores cancellation — a real loss of security/correctness
  // guarantees across the composition boundary.
  const childRunner = new GraphRunner(childGraph, childState, {
    loadGraphFn: ctx.loadGraphFn,
    onToken: ctx.onToken,
    toolResolver: ctx.toolResolver,
    modelResolver: ctx.modelResolver,
    contextCompressor: ctx.contextCompressor,
    memoryRetriever: ctx.memoryRetriever,
    memoryWriter: ctx.memoryWriter,
    factSanitizer: ctx.factSanitizer,
    fitnessFunction: ctx.fitnessFunction,
    ...(ctx.rateLimiter ? { rateLimiter: ctx.rateLimiter } : {}),
  });
  const finalChildState = await childRunner.run();

  // Map child outputs back to parent memory
  const outputUpdates: Record<string, unknown> = {};
  for (const [childKey, parentKey] of Object.entries(config.output_mapping)) {
    if (childKey in finalChildState.memory) {
      outputUpdates[parentKey] = finalChildState.memory[childKey];
    }
  }

  // Propagate child compensation stack to parent with namespaced IDs
  const childCompensation = finalChildState.compensation_stack;
  const compensationEntries = childCompensation.length > 0
    ? childCompensation.map(entry => ({
        action_id: `subgraph:${node.id}:${entry.action_id}`,
        compensation_action: entry.compensation_action,
      }))
    : undefined;

  if (compensationEntries) {
    logger.info('subgraph_compensation_propagated', {
      node_id: node.id,
      entries: compensationEntries.length,
    });
  }

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'update_memory',
    payload: { updates: outputUpdates },
    compensation_entries: compensationEntries,
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      token_usage: { totalTokens: finalChildState.total_tokens_used },
    },
  };
}
