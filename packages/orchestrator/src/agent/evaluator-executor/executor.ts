/**
 * Evaluator Executor
 *
 * LLM-as-judge quality evaluator used by self-annealing loops,
 * voting/consensus patterns, and the eval framework. Calls the LLM
 * with structured output to produce a normalised score (0–1),
 * reasoning, and optional improvement suggestions.
 *
 * @module evaluator-executor/executor
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { agentFactory } from '../agent-factory/index.js';
import { AgentLoadError } from '../agent-factory/errors.js';
import { createEvaluatorPrompt, createEvaluatorSystemPrompt } from './prompts.js';
import { createLogger } from '../../utils/logger.js';
import { getTracer, withSpan } from '../../utils/tracing.js';

const logger = createLogger('agent.evaluator');
const tracer = getTracer('orchestrator.evaluator');

/** Result of a single LLM-as-judge evaluation. */
export interface EvaluationResult {
  /** Normalised score between 0.0 (terrible) and 1.0 (perfect). */
  score: number;
  /** The evaluator's reasoning for the assigned score. */
  reasoning: string;
  /** Optional suggestions for improving the evaluated output. */
  suggestions?: string;
  /** Total tokens consumed by the evaluation call. */
  tokensUsed: number;
}

/** Zod schema for structured output extraction from the LLM. */
const EvaluationSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  suggestions: z.string().optional(),
});

/**
 * Evaluate the quality of an output using an LLM judge.
 *
 * Loads the evaluator agent's config, builds prompts with injection
 * guards, and calls the LLM with structured output extraction.
 *
 * @param evaluatorAgentId - The database ID of the evaluator agent.
 * @param goal - The original goal the output was generated for.
 * @param output - The output to evaluate (string or serialisable object).
 * @param criteria - Optional domain-specific evaluation criteria.
 * @returns The evaluation result with score, reasoning, and token usage.
 * @throws {AgentLoadError} If the evaluator agent cannot be loaded or the API key is missing.
 * @throws {Error} If the LLM call fails or returns unparseable structured output.
 */
export async function evaluateQualityExecutor(
  evaluatorAgentId: string,
  goal: string,
  output: unknown,
  criteria?: string,
): Promise<EvaluationResult> {
  return withSpan(tracer, 'evaluator.evaluate', async (span) => {
    span.setAttribute('evaluator.agent_id', evaluatorAgentId);

    const agentConfig = await agentFactory.loadAgent(evaluatorAgentId);
    const model = agentFactory.getModel(agentConfig);

    const systemPrompt = createEvaluatorSystemPrompt(agentConfig, criteria);
    const prompt = createEvaluatorPrompt(goal, output);

    logger.info('evaluating', { evaluator_agent_id: evaluatorAgentId, goal_length: goal.length });

    const { output: evaluation, usage } = await generateText({
      model,
      system: systemPrompt,
      prompt,
      output: Output.object({ schema: EvaluationSchema }),
      ...(agentConfig.providerOptions ? { providerOptions: agentConfig.providerOptions } : {}),
    });

    const tokensUsed = usage?.totalTokens ?? 0;

    logger.info('evaluation_complete', {
      evaluator_agent_id: evaluatorAgentId,
      score: evaluation.score,
      tokens_used: tokensUsed,
    });

    span.setAttribute('evaluator.score', evaluation.score);
    span.setAttribute('evaluator.tokens', tokensUsed);

    return {
      score: evaluation.score,
      reasoning: evaluation.reasoning,
      suggestions: evaluation.suggestions,
      tokensUsed,
    };
  });
}
