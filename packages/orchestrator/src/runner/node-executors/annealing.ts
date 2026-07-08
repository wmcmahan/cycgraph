/**
 * Self-Annealing Loop Executor
 *
 * Iteratively improves agent output by decreasing LLM temperature
 * across iterations and evaluating quality after each attempt.
 * Terminates early when a quality threshold is met or improvement
 * drops below a diminishing-returns delta.
 *
 * @module runner/node-executors/annealing
 */

import { JSONPath } from 'jsonpath-plus';
import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { ensureSaveToMemory } from './agent.js';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { resolveModelForAgent } from './resolve-model.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';
import { checkCompositeBudget, logCompositeBudgetStop } from './budget-guard.js';

const logger = createLogger('runner.node.annealing');

/**
 * Execute a self-annealing loop on an agent node.
 *
 * Each iteration runs the agent at an interpolated temperature
 * (initial → final), evaluates quality, and keeps the best result.
 *
 * @param node - Agent node with `annealing_config`.
 * @param stateView - Filtered state view for the agent.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context with injected dependencies.
 * @returns Best action across all iterations.
 */
export async function executeAnnealingLoop(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.annealing_config!;
  const agentId = node.agent_id!;

  logger.info('annealing_loop_start', {
    node_id: node.id,
    agent_id: agentId,
    max_iterations: config.max_iterations,
    threshold: config.threshold,
  });

  const agentConfig = await ctx.deps.loadAgent(agentId);
  const { modelOverride } = resolveModelForAgent(agentConfig, agentId, node.id, ctx);
  const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), agentId);

  let bestAction: Action | null = null;
  let bestScore = -1;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let observedModel: string | undefined;

  for (let iter = 0; iter < config.max_iterations; iter++) {
    // Incremental budget guard: stop before issuing another iteration's LLM
    // calls once accumulated spend crosses a node/workflow cap (the runner
    // only checks budgets after the whole annealing loop otherwise).
    if (iter > 0) {
      const decision = checkCompositeBudget(
        node,
        { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, model: observedModel },
        ctx,
      );
      if (decision.stop) {
        logCompositeBudgetStop(node.id, decision);
        break;
      }
    }

    // Linear temperature interpolation: initial → final
    const progress = config.max_iterations > 1 ? iter / (config.max_iterations - 1) : 1;
    const temperature = config.initial_temperature +
      (config.final_temperature - config.initial_temperature) * progress;

    // Inject annealing metadata into state view
    const annealingView: StateView = {
      ...stateView,
      memory: {
        ...stateView.memory,
        _annealing_iteration: iter,
        _annealing_temperature: temperature,
        ...(bestAction && iter > 0
          ? { _annealing_feedback: `Previous best score: ${bestScore}. Improve quality.` }
          : {}),
      },
    };

    const { onToken } = buildNodeCallbacks(node.id, ctx);
    const action = await ctx.deps.executeAgent(agentId, annealingView, tools, attempt, {
      temperatureOverride: temperature,
      nodeId: node.id,
      abortSignal: ctx.abortSignal,
      onToken,
      drainTaintEntries: ctx.deps.drainTaintEntries,
      ...(modelOverride ? { modelOverride } : {}),
      ...(node.default_write_key ? { defaultWriteKey: node.default_write_key } : {}),
      ...buildAgentMemoryOptions(node, ctx),
    });

    // Evaluate quality via evaluator agent or JSONPath extraction
    let score: number;
    let evalTokens = 0;

    if (config.evaluator_agent_id) {
      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.evaluator_agent_id,
        stateView.goal,
        action.payload.updates,
      );
      score = evalResult.score;
      evalTokens = evalResult.tokensUsed;
    } else {
      try {
        const results = JSONPath({ path: config.score_path, json: action.payload });
        score = typeof results[0] === 'number' ? results[0] : 0;
      } catch {
        score = 0;
      }
    }

    const actionUsage = action.metadata.token_usage;
    const actionTokens = actionUsage?.totalTokens ?? 0;
    totalTokens += actionTokens + evalTokens;
    totalInputTokens += actionUsage?.inputTokens ?? 0;
    totalOutputTokens += actionUsage?.outputTokens ?? 0;
    if (!observedModel && typeof action.metadata.model === 'string') {
      observedModel = action.metadata.model;
    }

    logger.info('annealing_iteration', {
      node_id: node.id,
      iteration: iter,
      score,
      best_score: bestScore,
      temperature,
    });

    if (score > bestScore) {
      const delta = score - bestScore;
      bestScore = score;
      bestAction = action;

      if (iter > 0 && delta < config.diminishing_returns_delta) {
        logger.info('annealing_diminishing_returns', {
          node_id: node.id,
          delta,
          threshold: config.diminishing_returns_delta,
        });
        break;
      }
    }

    if (bestScore >= config.threshold) {
      logger.info('annealing_threshold_met', {
        node_id: node.id,
        score: bestScore,
        threshold: config.threshold,
      });
      break;
    }
  }

  // Fall back to a no-op action if no iteration succeeded
  const result = bestAction ?? {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: { updates: {} },
    metadata: { node_id: node.id, timestamp: new Date(), attempt },
  };

  result.metadata = {
    ...result.metadata,
    token_usage: { totalTokens, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };

  return result;
}
