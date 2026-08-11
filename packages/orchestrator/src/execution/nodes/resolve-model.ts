/**
 * Shared model resolution helper for node executors.
 *
 * Single home for the budget-aware model-resolution logic shared by the
 * agent and supervisor executors.
 *
 * @module execution/nodes/resolve-model
 */
import { createLogger } from '../../observability/logger.js';
import type { ModelResolutionResult } from '../../agents/models/model-resolver.js';
import type { AgentConfigShape, NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.resolve-model');

export interface ModelResolutionOutcome {
  modelOverride?: string;
  resolution?: ModelResolutionResult;
}

/**
 * Resolve the model for an agent based on budget-aware model resolution.
 * Returns the model override and resolution result (if any).
 */
export function resolveModelForAgent(
  agentConfig: AgentConfigShape,
  agentId: string,
  nodeId: string,
  ctx: NodeExecutorContext,
): ModelResolutionOutcome {
  if (agentConfig.model_preference && !ctx.modelResolver) {
    logger.warn('model_preference_no_resolver', {
      agent_id: agentId,
      node_id: nodeId,
      preference: agentConfig.model_preference,
      fallback_model: agentConfig.model,
    });
    return {};
  }

  if (!agentConfig.model_preference || !ctx.modelResolver) {
    return {};
  }

  const remainingBudget = ctx.getRemainingBudgetUsd?.() ?? ctx.remainingBudgetUsd;
  const resolution = ctx.modelResolver(
    agentConfig.model_preference,
    agentConfig.provider,
    remainingBudget,
  );

  if (!resolution) {
    return {};
  }

  logger.info('model_resolved', {
    agent_id: agentId,
    node_id: nodeId,
    reason: resolution.reason,
    resolved_model: resolution.model,
    original_model: agentConfig.model,
    preference: agentConfig.model_preference,
    remaining_budget_usd: remainingBudget,
  });

  ctx.onModelResolved?.({
    agentId,
    originalModel: agentConfig.model,
    resolution,
  }, nodeId);

  return { modelOverride: resolution.model, resolution };
}
