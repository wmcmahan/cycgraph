/**
 * Synthesizer Node Executor
 *
 * Merges results from parallel fan-out nodes. If an `agent_id` is
 * configured, the agent performs intelligent synthesis; otherwise,
 * a simple concatenation of all `*_results` memory keys is used.
 *
 * @module runner/node-executors/synthesizer
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { ensureSaveToMemory } from './agent.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';

const logger = createLogger('runner.node.synthesizer');

/**
 * Execute a synthesizer node.
 *
 * @param node - Synthesizer node (optionally with `agent_id`).
 * @param stateView - Filtered state view containing parallel results.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `update_memory` action with merged results.
 */
export async function executeSynthesizerNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  logger.info('synthesizer_executing', { node_id: node.id });

  // Delegate to agent for intelligent synthesis
  if (node.agent_id) {
    const agentConfig = await ctx.deps.loadAgent(node.agent_id);
    const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), node.agent_id);
    const { onToken } = buildNodeCallbacks(node.id, ctx);
    return ctx.deps.executeAgent(node.agent_id, stateView, tools, attempt, {
      nodeId: node.id,
      abortSignal: ctx.abortSignal,
      onToken,
      drainTaintEntries: ctx.deps.drainTaintEntries,
      ...(node.default_write_key ? { defaultWriteKey: node.default_write_key } : {}),
      ...buildAgentMemoryOptions(node, ctx),
    });
  }

  // Simple merge: concatenate all *_results arrays from memory
  const merged: unknown[] = [];
  for (const [key, value] of Object.entries(stateView.memory)) {
    if (key.endsWith('_results') && Array.isArray(value)) {
      merged.push(...value);
    }
  }

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: {
      updates: { [`${node.id}_synthesis`]: merged },
    },
    metadata: { node_id: node.id, timestamp: new Date(), attempt },
  };
}
