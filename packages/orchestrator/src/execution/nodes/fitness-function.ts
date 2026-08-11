/**
 * Fitness Function
 *
 * Optional callback for `evolution` nodes that bypasses the LLM-as-judge
 * evaluator and computes fitness deterministically. Use this for tasks
 * with verifiable answers — regex matching, SQL parsing, code execution,
 * math problems — where the LLM judge's variance is larger than the
 * discrimination you need.
 *
 * Provided once via `GraphRunnerOptions.fitnessFunction`. When set, the
 * evolution executor calls it for every candidate instead of routing to
 * `evaluateQualityExecutor`. The agent `evaluator_agent_id` on
 * `evolution_config` may be omitted in that case.
 *
 * For multi-node graphs with distinct fitness needs, dispatch on
 * `goal` or other state inside your callback.
 *
 * @module agent/fitness-function
 */

/** Result of a deterministic fitness evaluation. */
export interface FitnessResult {
  /** Score in [0, 1]. The evolution executor uses this exactly as it would the LLM judge's score. */
  score: number;
  /** Optional explanation, surfaced into `evolve_winner_reasoning`. */
  reasoning?: string;
}

/**
 * Deterministic fitness evaluator. Called once per candidate per generation.
 *
 * @param output - The candidate's `action.payload.updates` blob. Cast to your expected shape.
 * @param goal - The workflow goal, useful for dispatch when one runner serves multiple evolution nodes.
 * @returns A score in [0, 1] and optional reasoning.
 */
export type FitnessFunction = (
  output: unknown,
  goal: string,
) => Promise<FitnessResult> | FitnessResult;
