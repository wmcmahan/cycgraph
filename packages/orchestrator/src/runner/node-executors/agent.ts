/**
 * Agent Node Executor
 *
 * Executes an agent node by delegating to the appropriate specialised
 * executor (annealing, swarm) or falling through to a standard LLM call.
 *
 * @module runner/node-executors/agent
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import type { ToolSource } from '../../types/tools.js';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { executeAnnealingLoop } from './annealing.js';
import { executeSwarmAgentNode } from './swarm.js';
import { resolveModelForAgent } from './resolve-model.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';

const logger = createLogger('runner.node.agent');

/**
 * Pass through tool sources unchanged.
 *
 * Previously this function auto-injected `save_to_memory` when the agent had
 * `write_keys`. This is no longer needed because the orchestrator now captures
 * agent text output directly and routes it to the appropriate write key via
 * {@link extractMemoryUpdates}. Agents that need structured multi-key writes
 * can still explicitly declare `save_to_memory` in their tools array.
 *
 * The function signature is preserved for backward compatibility with all
 * 7 call sites across node executors.
 */
export function ensureSaveToMemory(sources: ToolSource[], _writeKeys?: string[]): ToolSource[] {
  return sources;
}

/**
 * Execute an agent node.
 *
 * Routing priority:
 * 1. If `annealing_config` is set → self-annealing loop
 * 2. If `swarm_config` is set    → swarm peer delegation
 * 3. Otherwise                   → standard single-shot LLM call
 *
 * @param node - Graph node to execute (must have `agent_id`).
 * @param stateView - Filtered state view for the agent.
 * @param attempt - Retry attempt number (1-based).
 * @param ctx - Executor context with injected dependencies.
 * @returns Action produced by the agent.
 * @throws If `agent_id` is missing.
 */
export async function executeAgentNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const agentId = node.agent_id;
  if (!agentId) {
    throw new NodeConfigError(node.id, 'agent', 'agent_id');
  }

  if (node.annealing_config) {
    return executeAnnealingLoop(node, stateView, attempt, ctx);
  }

  if (node.swarm_config) {
    return executeSwarmAgentNode(node, stateView, attempt, ctx);
  }

  logger.info('agent_node_executing', { agent_id: agentId, node_id: node.id });

  const agentConfig = await ctx.deps.loadAgent(agentId);

  const { modelOverride } = resolveModelForAgent(agentConfig, agentId, node.id, ctx);

  const { onToken, onToolCall, onToolCallComplete, onContextCompressed } = buildNodeCallbacks(node.id, ctx);

  // Node-level tools override agent config tools
  const toolSources = ensureSaveToMemory(node.tools ?? agentConfig.tools, agentConfig.write_keys);
  const tools = await ctx.deps.resolveTools(toolSources, agentId);
  return ctx.deps.executeAgent(agentId, stateView, tools, attempt, {
    nodeId: node.id,
    abortSignal: ctx.abortSignal,
    onToken,
    onToolCall,
    onToolCallComplete,
    drainTaintEntries: ctx.deps.drainTaintEntries,
    ...(modelOverride ? { modelOverride } : {}),
    ...(node.default_write_key ? { defaultWriteKey: node.default_write_key } : {}),
    contextCompressor: ctx.contextCompressor,
    onContextCompressed,
    ...buildAgentMemoryOptions(node, ctx),
  });
}
