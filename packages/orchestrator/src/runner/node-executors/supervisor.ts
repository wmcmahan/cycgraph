/**
 * Supervisor Node Executor
 *
 * Delegates to the supervisor executor which uses an LLM to decide
 * which managed node to route work to next.
 *
 * @module runner/node-executors/supervisor
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';
import { resolveModelForAgent } from './resolve-model.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';

const logger = createLogger('runner.node.supervisor');

/**
 * Execute a supervisor node (LLM-powered dynamic routing).
 *
 * @param node - Supervisor node with `supervisor_config`.
 * @param stateView - Filtered state view for the supervisor LLM.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns Action containing the routing decision.
 */
export async function executeSupervisorNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  logger.info('supervisor_routing', { node_id: node.id, supervisor_config: node.supervisor_config });

  // ── Budget-Aware Model Resolution for Supervisors ──
  const supervisorAgentId = node.supervisor_config?.agent_id ?? node.agent_id;
  let modelOverride: string | undefined;
  if (supervisorAgentId) {
    const agentConfig = await ctx.deps.loadAgent(supervisorAgentId);
    const result = resolveModelForAgent(agentConfig, supervisorAgentId, node.id, ctx);
    modelOverride = result.modelOverride;
  }

  const { onContextCompressed } = buildNodeCallbacks(node.id, ctx);

  return ctx.deps.executeSupervisor(
    node,
    stateView,
    ctx.state.supervisor_history,
    attempt,
    {
      abortSignal: ctx.abortSignal,
      ...(modelOverride ? { modelOverride } : {}),
      contextCompressor: ctx.contextCompressor,
      onContextCompressed,
      ...buildAgentMemoryOptions(node, ctx),
    },
  );
}
