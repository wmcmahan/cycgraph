/**
 * Swarm Agent Node Executor
 *
 * Executes an agent with peer delegation capability. The agent requests
 * handoff to a peer by writing a `peer_delegation` object
 * (`{ peer_node_id, reason }`) to its output — typically via the
 * `save_to_memory` tool, so `peer_delegation` must be in the agent's
 * `write_keys`. The executor converts it into a `handoff` action.
 *
 * The legacy `_peer_delegation` key is still honoured for
 * executor-level callers, but real agents cannot produce it: the agent
 * executor blocks `_`-prefixed keys in agent output.
 *
 * @module runner/node-executors/swarm
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import { ensureSaveToMemory } from './agent.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { resolveModelForAgent } from './resolve-model.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';

const logger = createLogger('runner.node.swarm');

/**
 * Execute a swarm agent node.
 *
 * After the agent executes, checks for a `_peer_delegation` key in
 * the output. If present and valid, converts it to a `handoff` action.
 * If the handoff limit is reached, strips the delegation and returns
 * the agent's original action.
 *
 * @param node - Agent node with `swarm_config`.
 * @param stateView - Filtered state view.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns Agent action or handoff action.
 * @throws If the agent attempts handoff to a non-peer node.
 */
export async function executeSwarmAgentNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.swarm_config!;
  const agentId = node.agent_id!;

  logger.info('swarm_agent_executing', {
    node_id: node.id,
    agent_id: agentId,
    peer_nodes: config.peer_nodes,
  });

  // First-class state field (schema v2) — formerly `memory._swarm_handoff_count`.
  const handoffCount = ctx.state.swarm_handoff_count ?? 0;

  const swarmView: StateView = {
    ...stateView,
    // Rendered into the agent's prompt as `## Task Context` so the agent
    // can see its peers and remaining handoff budget (formerly a `_`-prefixed
    // memory key that sanitizeForPrompt stripped).
    taskContext: {
      swarm: {
        peer_nodes: config.peer_nodes,
        max_handoffs: config.max_handoffs,
        handoff_count: handoffCount,
      },
    },
  };

  const agentConfig = await ctx.deps.loadAgent(agentId);
  const { modelOverride } = resolveModelForAgent(agentConfig, agentId, node.id, ctx);
  const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), agentId);
  const { onToken } = buildNodeCallbacks(node.id, ctx);
  const action = await ctx.deps.executeAgent(agentId, swarmView, tools, attempt, {
    nodeId: node.id,
    idempotencyKey: nodeIdempotencyKey(node, ctx, attempt),
    grantedWriteKeys: node.write_keys,
    abortSignal: ctx.abortSignal,
    onToken,
    drainTaintEntries: ctx.deps.drainTaintEntries,
    ...(modelOverride ? { modelOverride } : {}),
    ...(node.default_write_key ? { defaultWriteKey: node.default_write_key } : {}),
    ...buildAgentMemoryOptions(node, ctx),
  });

  const updates = action.payload.updates as Record<string, unknown>;
  // `peer_delegation` is the agent-writable key; `_peer_delegation` is kept
  // for executor-level callers (agents cannot write `_`-prefixed keys).
  const delegation = (updates.peer_delegation ?? updates._peer_delegation) as
    | { peer_node_id: string; reason: string; context?: unknown }
    | undefined;

  if (delegation) {
    if (!config.peer_nodes.includes(delegation.peer_node_id)) {
      throw new NodeConfigError(node.id, 'swarm', `valid peer (attempted handoff to "${delegation.peer_node_id}")`);
    }

    if (handoffCount >= config.max_handoffs) {
      logger.warn('swarm_max_handoffs', { node_id: node.id, count: handoffCount, max: config.max_handoffs });
      delete updates._peer_delegation;
      delete updates.peer_delegation;
      return action;
    }

    // Omit the delegation directive from the carried memory — it has been
    // consumed by this handoff.
    const { _peer_delegation, peer_delegation, ...outputUpdates } = updates;

    return {
      id: uuidv4(),
      idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
      type: 'handoff',
      payload: {
        node_id: delegation.peer_node_id,
        supervisor_id: node.id,
        reasoning: delegation.reason,
        memory_updates: {
          ...outputUpdates,
          _swarm_handoff_count: handoffCount + 1,
        },
      },
      metadata: {
        node_id: node.id,
        agent_id: agentId,
        timestamp: new Date(),
        attempt,
      },
    };
  }

  return action;
}
