/**
 * evolution() — population-based selection over generations
 *
 * The candidate agent comes first: it is what gets bred. Fitness comes from
 * `evaluator`, or from `GraphRunnerOptions.fitnessFunction` when no evaluator
 * is named. One of the two must be present or the node throws at run time.
 *
 * Result keys are implied by the node type, so this spec takes no `writes`.
 *
 * @module authoring/evolution
 */

import type { AgentValue } from './agent.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link evolution}. */
export interface EvolutionSpec extends NodeCommon {
  /** Scoring agent. Omit only when a `fitnessFunction` is wired on the runner. */
  evaluator?: AgentValue | string;
  /** Candidates per generation. */
  populationSize?: number;
  /** Generations before the loop stops. */
  maxGenerations?: number;
  /** Stop early once the best candidate reaches this fitness. Above 1 disables early exit. */
  fitnessThreshold?: number;
  /** Stop after this many generations without improvement. */
  stagnationGenerations?: number;
  /** How parents are chosen. */
  selection?: 'rank' | 'tournament' | 'roulette';
  /** Top candidates carried into the next generation unchanged. */
  eliteCount?: number;
  /** Candidates evaluated at once. */
  concurrency?: number;
  /** Starting temperature: how widely early generations explore. */
  initialTemperature?: number;
  /** Ending temperature: how tightly late generations exploit. */
  finalTemperature?: number;
  /** Entrants per tournament, for the `tournament` selection strategy. */
  tournamentSize?: number;
  /** Per-candidate timeout in milliseconds. */
  taskTimeoutMs?: number;
  /** Extra instruction for the evaluator. */
  criteria?: string;
  /** What a failing candidate does to the node. */
  onError?: 'fail_fast' | 'best_effort';
}

/**
 * Author an `evolution` node.
 *
 * @param candidate - The agent that generates candidate solutions.
 * @param spec - Placement, scoring, and population settings.
 */
export function evolution(candidate: AgentValue | string, spec: EvolutionSpec): NodeValue {
  const {
    evaluator, populationSize, maxGenerations, fitnessThreshold, stagnationGenerations,
    selection, eliteCount, concurrency, criteria, onError,
    initialTemperature, finalTemperature, tournamentSize, taskTimeoutMs, ...placement
  } = spec;

  return {
    ...placement,
    type: 'evolution' as const,
    evolutionConfig: {
      candidateAgentId: candidate,
      ...(evaluator !== undefined ? { evaluatorAgentId: evaluator } : {}),
      ...(populationSize !== undefined ? { populationSize } : {}),
      ...(maxGenerations !== undefined ? { maxGenerations } : {}),
      ...(fitnessThreshold !== undefined ? { fitnessThreshold } : {}),
      ...(stagnationGenerations !== undefined ? { stagnationGenerations } : {}),
      ...(selection !== undefined ? { selectionStrategy: selection } : {}),
      ...(eliteCount !== undefined ? { eliteCount } : {}),
      ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
      ...(criteria !== undefined ? { evaluationCriteria: criteria } : {}),
      ...(onError !== undefined ? { errorStrategy: onError } : {}),
      ...(initialTemperature !== undefined ? { initialTemperature } : {}),
      ...(finalTemperature !== undefined ? { finalTemperature } : {}),
      ...(tournamentSize !== undefined ? { tournamentSize } : {}),
      ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue;
}
