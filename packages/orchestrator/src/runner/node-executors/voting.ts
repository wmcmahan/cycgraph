import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { executeParallel, type ParallelTask } from '../parallel-executor.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { ensureSaveToMemory } from './agent.js';
import { resolveModelForAgent } from './resolve-model.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { LESSON_PROVENANCE_KEY } from '../../utils/lesson-provenance.js';
import { combineAbortSignals } from '../../utils/abort.js';
import { aggregateParallelTaint } from '../../utils/taint.js';

const logger = createLogger('runner.node.voting');

/**
 * Produce a canonical JSON string for any value.
 * Object keys are recursively sorted to ensure `{a:1,b:2}` and
 * `{b:2,a:1}` produce identical strings.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalStringify(v)).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Execute voting node: parallel voters + consensus.
 * 
 * Description:
 * This function implements a voting node that executes multiple voters in parallel
 * and aggregates their results based on a specified strategy (majority vote, weighted vote, or LLM judge).
 * It supports configurable quorum, weights, and judge agent.
 * 
 * @param node - The node to execute.
 * @param stateView - The state view for the node.
 * @param attempt - The attempt number.
 * @param ctx - The node executor context.
 * @returns The action result.
 */
export async function executeVotingNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.voting_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'voting', 'voting_config');
  }

  logger.info('voting_node_executing', {
    node_id: node.id,
    voter_count: config.voter_agent_ids.length,
    strategy: config.strategy,
  });

  // Create synthetic agent nodes for each voter. The parent node's
  // `memory_query` propagates so every voter sees the same retrieved
  // memory in their prompt.
  const tasks: ParallelTask[] = config.voter_agent_ids.map((agent_id, idx) => ({
    node: {
      id: `${node.id}_voter_${idx}`,
      type: 'agent' as const,
      agent_id,
      read_keys: node.read_keys,
      write_keys: [config.vote_key],
      failure_policy: node.failure_policy,
      requires_compensation: false,
      ...(node.memory_query ? { memory_query: node.memory_query } : {}),
    },
    stateView: {
      ...stateView,
      memory: {
        ...stateView.memory,
        _vote_key: config.vote_key,
        _voter_index: idx,
        _voter_count: config.voter_agent_ids.length,
      },
    },
  }));

  // Execute all voters in parallel
  const results = await executeParallel(
    tasks,
    async (task, taskSignal) => {
      const agentConfig = await ctx.deps.loadAgent(task.node.agent_id!);
      const { modelOverride } = resolveModelForAgent(agentConfig, task.node.agent_id!, task.node.id, ctx);
      const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), task.node.agent_id!);
      const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, task.node.id) : undefined;
      const abortSignal = combineAbortSignals(ctx.abortSignal, taskSignal);
      return ctx.deps.executeAgent(task.node.agent_id!, task.stateView, tools, attempt, { node_id: task.node.id, abortSignal, onToken, drainTaintEntries: ctx.deps.drainTaintEntries, ...(modelOverride ? { model_override: modelOverride } : {}), ...(task.node.default_write_key ? { default_write_key: task.node.default_write_key } : {}), ...buildAgentMemoryOptions(task.node, ctx) });
    },
    { max_concurrency: config.voter_agent_ids.length, error_strategy: 'best_effort', task_timeout_ms: config.task_timeout_ms },
  );

  // Extract votes from action payloads. Lesson provenance recorded by each
  // voter is forwarded into the merged action — without this, facts injected
  // into voters' prompts would never be attributable to the run's outcome.
  const votes: Array<{ agent_id: string; vote: unknown }> = [];
  const lessonProvenance: Record<string, unknown> = {};
  for (const result of results) {
    if (!result.success || !result.action) continue;
    const updates = result.action.payload.updates as Record<string, unknown>;
    const voterProvenance = updates[LESSON_PROVENANCE_KEY];
    if (voterProvenance && typeof voterProvenance === 'object' && !Array.isArray(voterProvenance)) {
      Object.assign(lessonProvenance, voterProvenance);
    }
    const vote = updates[config.vote_key] ?? updates['agent_response'];
    const agentIdx = result.task_index;
    votes.push({
      agent_id: config.voter_agent_ids[agentIdx],
      vote,
    });
  }

  // Check quorum
  if (config.quorum && votes.length < config.quorum) {
    throw new NodeConfigError(node.id, 'voting', `quorum (got ${votes.length}, need ${config.quorum})`);
  }

  // Aggregate votes by strategy. Sum input/output tokens separately from
  // each voter's action so the runner's cost-tracking path can derive cost.
  // Capture the model from the first voter — every voter runs the same agent
  // so the model is uniform.
  let consensus: unknown;
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
  let extraTokens = 0;

  switch (config.strategy) {
    case 'majority_vote': {
      const tally = new Map<string, number>();
      const originals = new Map<string, unknown>();
      for (const v of votes) {
        const key = canonicalStringify(v.vote);
        tally.set(key, (tally.get(key) || 0) + 1);
        if (!originals.has(key)) originals.set(key, v.vote);
      }
      let maxCount = 0;
      let winnerKey = '';
      for (const [key, count] of tally) {
        if (count > maxCount) {
          maxCount = count;
          winnerKey = key;
        }
      }
      if (!winnerKey) {
        throw new NodeConfigError(node.id, 'voting', 'votes (no votes received for majority_vote)');
      }
      consensus = originals.get(winnerKey);
      break;
    }

    case 'weighted_vote': {
      const weights = config.weights || {};
      const tally = new Map<string, number>();
      const originals = new Map<string, unknown>();
      for (const v of votes) {
        const key = canonicalStringify(v.vote);
        const weight = weights[v.agent_id] ?? 1;
        tally.set(key, (tally.get(key) || 0) + weight);
        if (!originals.has(key)) originals.set(key, v.vote);
      }
      let maxWeight = 0;
      let winnerKey = '';
      for (const [key, weight] of tally) {
        if (weight > maxWeight) {
          maxWeight = weight;
          winnerKey = key;
        }
      }
      if (!winnerKey) {
        throw new NodeConfigError(node.id, 'voting', 'votes (no votes received for weighted_vote)');
      }
      consensus = originals.get(winnerKey);
      break;
    }

    case 'llm_judge': {
      if (!config.judge_agent_id) {
        throw new NodeConfigError(node.id, 'voting', 'judge_agent_id');
      }
      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.judge_agent_id,
        stateView.goal,
        votes,
        'Select the best vote and explain why.',
      );
      consensus = evalResult.reasoning;
      extraTokens = evalResult.tokens_used;
      // Evaluator currently reports only totalTokens; attribute conservatively
      // to output so the cost path still computes a non-zero figure.
      totalOutputTokens += extraTokens;
      break;
    }
  }

  const finalTotalTokens = totalTokens + extraTokens;

  // Re-surface worker taint: tainted voter output is buried under the
  // consensus/votes keys, so mark them tainted in the parent registry
  // (mergeMemory treats `_taint_registry` append-only).
  const taintUpdates = aggregateParallelTaint(
    results.map(r => r.action?.payload.updates as Record<string, unknown> | undefined),
    [`${node.id}_consensus`, `${node.id}_votes`],
    node.id,
  );

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'merge_parallel_results',
    payload: {
      updates: {
        [`${node.id}_consensus`]: consensus,
        [`${node.id}_votes`]: votes,
        ...(Object.keys(lessonProvenance).length > 0
          ? { [LESSON_PROVENANCE_KEY]: lessonProvenance }
          : {}),
        ...(Object.keys(taintUpdates).length > 0
          ? { _taint_registry: taintUpdates }
          : {}),
      },
      total_tokens: finalTotalTokens,
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      ...(observedModel ? { model: observedModel } : {}),
      token_usage: {
        totalTokens: finalTotalTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    },
  };
}
