/**
 * Evolution (DGM) Node Executor
 *
 * Population-based Darwinian selection: generates N candidates per
 * generation, scores them via a fitness evaluator, selects the best,
 * and breeds the next generation using the winner as parent context.
 * Temperature controls diversity vs exploitation.
 *
 * @module runner/node-executors/evolution
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { executeParallel, type ParallelTask } from '../parallel-executor.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { ensureSaveToMemory } from './agent.js';
import { resolveModelForAgent } from './resolve-model.js';
import { LESSON_PROVENANCE_KEY } from '../../utils/lesson-provenance.js';
import { buildAgentMemoryOptions } from './memory-options.js';
import { buildNodeCallbacks } from './node-callbacks.js';
import { checkCompositeBudget, logCompositeBudgetStop } from './budget-guard.js';
import { combineAbortSignals } from '../../utils/abort.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { aggregateParallelTaint } from '../../utils/taint.js';

const logger = createLogger('runner.node.evolution');

/**
 * Select a parent candidate using the configured strategy.
 *
 * - **rank**: pick the top candidate (index 0 after sort).
 * - **tournament**: pick `tournamentSize` random candidates, select the best.
 * - **roulette**: fitness-proportional probability selection.
 *
 * @param candidates - Sorted descending by fitness.
 * @param strategy - Selection strategy name.
 * @param tournamentSize - Tournament group size (only for 'tournament').
 * @returns The selected candidate.
 */
function selectWinner(
  candidates: ScoredCandidate[],
  strategy: 'rank' | 'tournament' | 'roulette',
  tournamentSize: number = 3,
): ScoredCandidate {
  if (candidates.length === 1) return candidates[0];

  switch (strategy) {
    case 'rank':
      return candidates[0];

    case 'tournament': {
      const size = Math.min(tournamentSize, candidates.length);
      // Fisher-Yates partial shuffle to pick `size` random candidates
      const indices = candidates.map((_, i) => i);
      for (let i = 0; i < size; i++) {
        const j = i + Math.floor(Math.random() * (indices.length - i));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const group = indices.slice(0, size).map(i => candidates[i]);
      // Best in group (candidates already sorted, but group may not be in order)
      return group.reduce((best, c) => c.fitness > best.fitness ? c : best, group[0]);
    }

    case 'roulette': {
      const totalFitness = candidates.reduce((sum, c) => sum + c.fitness, 0);
      // Fallback to rank if all fitness values are zero
      if (totalFitness === 0) return candidates[0];
      const spin = Math.random() * totalFitness;
      let cumulative = 0;
      for (const candidate of candidates) {
        cumulative += candidate.fitness;
        if (cumulative >= spin) return candidate;
      }
      // Floating point guard
      return candidates[candidates.length - 1];
    }

    default:
      return candidates[0];
  }
}

/** A scored candidate from a single generation. */
interface ScoredCandidate {
  /** Index within the generation's parallel batch. */
  index: number;
  /** Raw agent output. */
  output: unknown;
  /** Fitness score (0–1). */
  fitness: number;
  /** Evaluator's reasoning. */
  reasoning: string;
  /** Total tokens consumed (generation + evaluation). */
  tokensUsed: number;
  /** True if this candidate was carried forward unchanged from a prior generation (elitism). */
  is_elite?: boolean;
}

/**
 * Execute an evolution (DGM) node.
 *
 * Runs multiple generations of parallel candidate agents, each scored
 * by a fitness evaluator. Terminates early when the fitness threshold
 * is met or stagnation is detected.
 *
 * @param node - Evolution node with `evolution_config`.
 * @param stateView - Filtered state view.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `merge_parallel_results` action with winner and fitness history.
 * @throws If `evolution_config` is missing or all candidates fail under `fail_fast`.
 */
export async function executeEvolutionNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.evolution_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'evolution', 'evolution_config');
  }

  logger.info('evolution_node_start', {
    node_id: node.id,
    population_size: config.population_size,
    max_generations: config.max_generations,
    fitness_threshold: config.fitness_threshold,
    selection_strategy: config.selection_strategy,
  });

  let bestCandidate: ScoredCandidate | null = null;
  let parentForNextGen: ScoredCandidate | null = null;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // Captured from the first successful candidate's action — every candidate
  // runs the same agent so the model is uniform. Used to resolve pricing.
  let observedModel: string | undefined;
  let stagnationCount = 0;
  const fitnessHistory: number[] = [];
  let finalPopulation: ScoredCandidate[] = [];
  let generationsRun = 0;
  // Lesson provenance forwarded from every candidate across all generations.
  // Losers count too: a fact retrieved into a losing candidate's prompt was
  // still trialled by this run.
  const lessonProvenance: Record<string, unknown> = {};
  // Worker updates (across all generations) that carried taint. Any tainted
  // candidate output means the winner/population blobs are derived from
  // untrusted data, so the aggregate keys must be marked tainted too.
  const taintedWorkerUpdates: Record<string, unknown>[] = [];

  // Elitism: the top `elite_count` candidates of each generation are carried
  // UNCHANGED into the next generation's pool — not re-generated and not
  // re-scored. This guarantees the best-so-far can never be lost to a noisy
  // generation, so per-generation best fitness is monotonic non-decreasing
  // (and it saves the LLM calls those slots would have cost). Clamped to leave
  // at least one fresh candidate per generation; `elite_count: 0` disables it.
  const eliteCount = Math.min(config.elite_count, config.population_size - 1);
  let elites: ScoredCandidate[] = [];

  let budgetStopped = false;
  for (let gen = 0; gen < config.max_generations; gen++) {
    if (ctx.abortSignal?.aborted) break;

    // Incremental budget guard: stop BEFORE issuing another generation's
    // worth of LLM calls if accumulated spend has crossed a cap. Without
    // this, the per-node/workflow budget is only checked after the whole
    // population × generations spend has already happened.
    if (gen > 0) {
      const decision = checkCompositeBudget(
        node,
        { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, model: observedModel },
        ctx,
      );
      if (decision.stop) {
        logCompositeBudgetStop(node.id, decision);
        budgetStopped = true;
        break;
      }
    }

    generationsRun = gen + 1;

    // Linear temperature interpolation: initial → final
    const progress = config.max_generations > 1 ? gen / (config.max_generations - 1) : 1;
    const temperature = config.initial_temperature +
      (config.final_temperature - config.initial_temperature) * progress;

    // Generate enough fresh candidates to fill the population alongside the
    // carried-forward elites (none in gen 0). The parent node's `memory_query`
    // propagates so every candidate sees the same retrieved memory in its prompt.
    const freshCount = config.population_size - elites.length;
    const tasks: ParallelTask[] = Array.from({ length: freshCount }, (_, idx) => ({
      node: {
        id: `${node.id}_gen${gen}_candidate${idx}`,
        type: 'agent' as const,
        agent_id: config.candidate_agent_id,
        read_keys: node.read_keys,
        write_keys: ['*'],
        failure_policy: node.failure_policy,
        requires_compensation: false,
        ...(node.memory_query ? { memory_query: node.memory_query } : {}),
      },
      stateView: {
        ...stateView,
        memory: {
          ...stateView.memory,
          _evolution_generation: gen,
          _evolution_candidate_index: idx,
          _evolution_population_size: config.population_size,
          _evolution_best_fitness: bestCandidate?.fitness ?? null,
          ...(gen > 0 && parentForNextGen ? {
            _evolution_parent: parentForNextGen.output,
            _evolution_parent_fitness: parentForNextGen.fitness,
            // Reasoning surfaces *why* the parent scored what it did.
            // Critical for iteration — without it, the candidate has no
            // signal about which specific tests the parent failed and
            // can only blindly mutate.
            _evolution_parent_reasoning: parentForNextGen.reasoning,
          } : {}),
        },
      },
    }));

    const results = await executeParallel(
      tasks,
      async (task, taskSignal) => {
        const agentConfig = await ctx.deps.loadAgent(task.node.agent_id!);
        const { modelOverride } = resolveModelForAgent(agentConfig, task.node.agent_id!, task.node.id, ctx);
        const tools = await ctx.deps.resolveTools(ensureSaveToMemory(agentConfig.tools, agentConfig.write_keys), task.node.agent_id!);
        const { onToken } = buildNodeCallbacks(task.node.id, ctx);
        // Combine the workflow-level signal with the per-task timeout signal
        // so a task_timeout_ms actually aborts the underlying LLM call instead
        // of leaving it running (and burning uncounted tokens) in the background.
        const abortSignal = combineAbortSignals(ctx.abortSignal, taskSignal);
        return ctx.deps.executeAgent(
          task.node.agent_id!,
          task.stateView,
          tools,
          attempt,
          { temperatureOverride: temperature, nodeId: task.node.id, abortSignal, onToken, drainTaintEntries: ctx.deps.drainTaintEntries, ...(modelOverride ? { modelOverride } : {}), ...(task.node.default_write_key ? { defaultWriteKey: task.node.default_write_key } : {}), ...buildAgentMemoryOptions(task.node, ctx) },
        );
      },
      { maxConcurrency: config.max_concurrency, errorStrategy: config.error_strategy, taskTimeoutMs: config.task_timeout_ms },
    );

    // First pass (sequential, cheap): keep successful candidates and fold their
    // generation-token accounting in deterministic order.
    const produced: Array<{ index: number; output: unknown; tokens: number }> = [];
    for (const result of results) {
      if (!result.success || !result.action) continue;

      // Strip the provenance registry from candidate output so the fitness
      // judge never sees registry noise and the winner blob stays clean;
      // union it into the node-level accumulator instead.
      const rawUpdates = result.action.payload.updates as Record<string, unknown>;
      const { [LESSON_PROVENANCE_KEY]: candidateProvenance, ...candidateOutput } = rawUpdates;
      if (candidateProvenance && typeof candidateProvenance === 'object' && !Array.isArray(candidateProvenance)) {
        Object.assign(lessonProvenance, candidateProvenance);
      }
      // Record any worker taint so the winner/population keys inherit it below.
      const candidateRegistry = rawUpdates._taint_registry;
      if (
        candidateRegistry &&
        typeof candidateRegistry === 'object' &&
        !Array.isArray(candidateRegistry) &&
        Object.keys(candidateRegistry).length > 0
      ) {
        taintedWorkerUpdates.push({ _taint_registry: candidateRegistry });
      }
      const usage = result.action.metadata.token_usage;
      const actionInputTokens = usage?.inputTokens ?? 0;
      const actionOutputTokens = usage?.outputTokens ?? 0;
      const actionTokens = usage?.totalTokens ?? (actionInputTokens + actionOutputTokens);
      totalInputTokens += actionInputTokens;
      totalOutputTokens += actionOutputTokens;
      totalTokens += actionTokens;
      if (!observedModel && typeof result.action.metadata.model === 'string') {
        observedModel = result.action.metadata.model;
      }
      produced.push({ index: result.taskIndex, output: candidateOutput, tokens: actionTokens });
    }

    // Fail fast on misconfiguration before issuing any evaluator calls. Prefer
    // the runner-injected deterministic `fitnessFunction` (free, exact, no judge
    // variance); fall back to the LLM-as-judge `evaluator_agent_id`.
    if (produced.length > 0 && !ctx.fitnessFunction && !config.evaluator_agent_id) {
      throw new NodeConfigError(
        node.id,
        'evolution',
        'evaluator_agent_id or GraphRunnerOptions.fitnessFunction',
      );
    }

    // Second pass (bounded-parallel): score candidates concurrently. The
    // evaluator LLM call dominates wall-clock, so scoring N candidates one at a
    // time made each generation take ~N× a single evaluation. Concurrency is
    // capped by the same `max_concurrency` knob used for candidate generation.
    const scored = await mapWithConcurrency(produced, config.max_concurrency, async (cand) => {
      if (ctx.fitnessFunction) {
        const r = await ctx.fitnessFunction(cand.output, stateView.goal);
        return { ...cand, fitness: r.score, reasoning: r.reasoning ?? '', evalTokens: 0 };
      }
      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.evaluator_agent_id!,
        stateView.goal,
        cand.output,
        config.evaluation_criteria,
      );
      return {
        ...cand,
        fitness: evalResult.score,
        reasoning: evalResult.reasoning,
        evalTokens: evalResult.tokensUsed,
      };
    });

    const freshCandidates: ScoredCandidate[] = [];
    for (const r of scored) {
      // Evaluator currently reports only totalTokens; attribute conservatively
      // to output so the cost path still computes a non-zero figure.
      totalTokens += r.evalTokens;
      totalOutputTokens += r.evalTokens;
      freshCandidates.push({
        index: r.index,
        output: r.output,
        fitness: r.fitness,
        reasoning: r.reasoning,
        tokensUsed: r.tokens,
      });
    }

    // The generation's pool = freshly generated candidates + carried-forward
    // elites (already scored in a prior generation, so they cost nothing here).
    const candidates: ScoredCandidate[] = [...freshCandidates, ...elites];

    // Handle all-failed generation (no fresh candidates AND no elites to fall
    // back on — i.e. generation 0 produced nothing).
    if (candidates.length === 0) {
      if (config.error_strategy === 'fail_fast') {
        throw new NodeConfigError(node.id, 'evolution', `candidates (all failed in generation ${gen})`);
      }
      fitnessHistory.push(bestCandidate?.fitness ?? 0);
      stagnationCount++;
      if (stagnationCount >= config.stagnation_generations) {
        logger.info('evolution_stagnation', { node_id: node.id, gen, stagnation_count: stagnationCount });
        break;
      }
      continue;
    }

    // Sort by fitness descending
    candidates.sort((a, b) => b.fitness - a.fitness);
    finalPopulation = candidates;

    // Carry the top `eliteCount` of this pool into the next generation
    // unchanged. Because they re-enter next round's pool, next round's best is
    // guaranteed ≥ this round's best → the fitness curve never dips.
    elites = eliteCount > 0
      ? candidates.slice(0, eliteCount).map((c) => ({ ...c, is_elite: true }))
      : [];

    const genBestFitness = candidates[0].fitness;
    fitnessHistory.push(genBestFitness);

    // Select parent for next generation using configured strategy
    const selectedParent = selectWinner(
      candidates,
      config.selection_strategy,
      config.tournament_size,
    );

    logger.info('evolution_generation_complete', {
      node_id: node.id,
      generation: gen,
      best_fitness: genBestFitness,
      overall_best: bestCandidate?.fitness ?? -1,
      selected_parent_fitness: selectedParent.fitness,
      candidates_scored: candidates.length,
      temperature,
    });

    // Track absolute best (always rank-based, regardless of selection strategy)
    if (!bestCandidate || genBestFitness > bestCandidate.fitness) {
      bestCandidate = candidates[0];
      stagnationCount = 0;
    } else {
      stagnationCount++;
    }

    // Use selected parent (not necessarily the absolute best) for breeding
    parentForNextGen = selectedParent;

    // Early exit checks
    if (bestCandidate.fitness >= config.fitness_threshold) {
      logger.info('evolution_fitness_threshold_met', {
        node_id: node.id,
        fitness: bestCandidate.fitness,
        threshold: config.fitness_threshold,
        generation: gen,
      });
      break;
    }

    if (stagnationCount >= config.stagnation_generations) {
      logger.info('evolution_stagnation', { node_id: node.id, gen, stagnation_count: stagnationCount });
      break;
    }
  }

  // Re-surface worker taint onto the aggregate output keys derived from
  // candidate output (mergeMemory treats `_taint_registry` append-only).
  const taintUpdates = aggregateParallelTaint(
    taintedWorkerUpdates,
    [
      `${node.id}_winner`,
      `${node.id}_winner_reasoning`,
      `${node.id}_population`,
    ],
    node.id,
  );

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'merge_parallel_results',
    payload: {
      updates: {
        [`${node.id}_winner`]: bestCandidate?.output ?? null,
        [`${node.id}_winner_fitness`]: bestCandidate?.fitness ?? 0,
        [`${node.id}_winner_reasoning`]: bestCandidate?.reasoning ?? '',
        [`${node.id}_generation`]: generationsRun,
        [`${node.id}_fitness_history`]: fitnessHistory,
        // Store per-candidate fitness *summaries*, not the full population. The
        // winning candidate's full output already lives in `${node.id}_winner`;
        // persisting every candidate's complete `output` for every generation
        // bloated WorkflowState (and every checkpoint) without adding signal.
        [`${node.id}_population`]: finalPopulation.map((c) => ({
          index: c.index,
          fitness: c.fitness,
          reasoning: c.reasoning,
          tokens_used: c.tokensUsed,
          ...(c.is_elite ? { is_elite: true } : {}),
        })),
        [`${node.id}_budget_stopped`]: budgetStopped,
        ...(Object.keys(lessonProvenance).length > 0
          ? { [LESSON_PROVENANCE_KEY]: lessonProvenance }
          : {}),
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
