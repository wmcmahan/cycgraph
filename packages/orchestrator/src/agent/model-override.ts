/**
 * Budget-Aware Model Override Resolution
 *
 * Shared by the agent and supervisor executors: applies a runner-supplied
 * `model_override` (from the ModelResolver) onto a loaded agent config.
 * An empty or blank override is rejected — logged as
 * `invalid_model_override` — and the config's static model is kept.
 *
 * @module agent/model-override
 */

import type { AgentConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent.model-override');

/**
 * Resolve the effective agent config for this execution: the loaded
 * config with `model` replaced by a validated `model_override`, or the
 * config unchanged when no valid override is present.
 */
export function resolveEffectiveModelConfig(
  config: AgentConfig,
  modelOverride: string | undefined,
  context: { agentId: string; nodeId?: string },
): AgentConfig {
  const validatedOverride =
    modelOverride && typeof modelOverride === 'string' && modelOverride.trim().length > 0
      ? modelOverride
      : undefined;

  if (modelOverride && !validatedOverride) {
    logger.warn('invalid_model_override', {
      agent_id: context.agentId,
      node_id: context.nodeId,
      model_override: modelOverride,
      fallback_model: config.model,
    });
  }

  return validatedOverride ? { ...config, model: validatedOverride } : config;
}
