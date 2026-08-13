/**
 * Evaluator Executor
 *
 * LLM-as-judge quality evaluator used by self-annealing loops,
 * voting/consensus patterns, and the eval framework. Calls the LLM
 * with structured output to produce a normalised score (0–1),
 * reasoning, and optional improvement suggestions.
 *
 * @module agents/executors/evaluator/executor
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { agentFactory, AgentFactory } from '../../factory/index.js';
import { AgentExecutionError } from '../agent/errors.js';
import { classifyRetryable } from '../agent/error-classification.js';
import { createEvaluatorPrompt, createEvaluatorSystemPrompt } from './prompts.js';
import { createLogger } from '../../../observability/logger.js';
import { getTracer, withSpan } from '../../../observability/tracing.js';

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
 * @throws {AgentExecutionError} If the LLM call fails or returns unparseable structured output (carries retryable classification).
 */
export async function evaluateQualityExecutor(
  evaluatorAgentId: string,
  goal: string,
  output: unknown,
  criteria?: string,
  factory: AgentFactory = agentFactory,
): Promise<EvaluationResult> {
  return withSpan(tracer, 'evaluator.evaluate', async (span) => {
    span.setAttribute('evaluator.agent_id', evaluatorAgentId);

    const agentConfig = await factory.loadAgent(evaluatorAgentId);
    const model = factory.getModel(agentConfig);

    const systemPrompt = createEvaluatorSystemPrompt(agentConfig, criteria);
    const prompt = createEvaluatorPrompt(goal, output);

    logger.info('evaluating', { evaluator_agent_id: evaluatorAgentId, goal_length: goal.length });

    let evaluation: z.infer<typeof EvaluationSchema>;
    let usage: { totalTokens?: number } | undefined;
    try {
      const result = await generateText({
        model,
        instructions: systemPrompt,
        prompt,
        output: Output.object({ schema: EvaluationSchema }),
        ...(agentConfig.maxOutputTokens !== undefined ? { maxOutputTokens: agentConfig.maxOutputTokens } : {}),
        ...(agentConfig.providerOptions ? { providerOptions: agentConfig.providerOptions } : {}),
      });
      evaluation = result.output;
      usage = result.usage;
    } catch (error) {
      // Same taxonomy as agent/supervisor calls: carry the retryable
      // classification so the runner's retry loop short-circuits a
      // deterministic 400 instead of re-issuing it max_retries times.
      throw new AgentExecutionError(evaluatorAgentId, error, undefined, classifyRetryable(error));
    }

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
