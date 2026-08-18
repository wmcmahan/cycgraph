/**
 * Extractor Executor
 *
 * LLM-as-extractor primitive. Given source text, asks an agent to distill
 * it into a bounded list of atomic facts. Used by the `reflection` node's
 * `llm` variant to produce structured lessons from agent output.
 *
 * Mirrors {@link evaluateQualityExecutor} in shape — same DI pattern,
 * same sanitisation, same `generateText` + `Output.object` extraction —
 * but returns a fact list instead of a quality score.
 *
 * @module agents/executors/extractor/executor
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { agentFactory, AgentFactory } from '../../factory/index.js';
import { AgentExecutionError } from '../agent/errors.js';
import { classifyRetryable } from '../agent/error-classification.js';
import { createExtractorPrompt, createExtractorSystemPrompt } from './prompts.js';
import { createLogger } from '../../../observability/logger.js';
import { getTracer, withSpan } from '../../../observability/tracing.js';

const logger = createLogger('agent.extractor');
const tracer = getTracer('orchestrator.extractor');

/** Result of a single LLM extraction call. */
export interface ExtractionResult {
  /** Atomic fact sentences produced by the LLM. */
  facts: string[];
  /** Optional explanation of how the facts were chosen. */
  reasoning?: string;
  /** Total tokens consumed by the extraction call. */
  tokensUsed: number;
}

/** Default cap on the number of facts the LLM may return per call. */
export const DEFAULT_MAX_FACTS = 10;

/** Default max chars per individual fact — prevents runaway emissions. */
const MAX_FACT_LENGTH = 280;

/** Schema for structured output extraction from the LLM. */
const ExtractionSchema = z.object({
  facts: z.array(z.string().min(1).max(MAX_FACT_LENGTH)).max(50),
  reasoning: z.string().optional(),
});

/**
 * Run the LLM extractor.
 *
 * @param extractorAgentId - The registry ID of the extractor agent.
 * @param source - Source text to distill (string or serialisable object).
 * @param maxFacts - Soft cap requested in the prompt; the LLM may return fewer.
 * @param instruction - Optional override instruction passed to the prompt.
 * @returns The extraction result with facts, reasoning, and token usage.
 */
export async function extractFactsExecutor(
  extractorAgentId: string,
  source: unknown,
  maxFacts: number = DEFAULT_MAX_FACTS,
  instruction?: string,
  factory: AgentFactory = agentFactory,
): Promise<ExtractionResult> {
  return withSpan(tracer, 'extractor.extract', async (span) => {
    span.setAttribute('extractor.agent_id', extractorAgentId);
    span.setAttribute('extractor.max_facts', maxFacts);

    const agentConfig = await factory.loadAgent(extractorAgentId);
    const model = factory.getModel(agentConfig);

    const systemPrompt = createExtractorSystemPrompt(agentConfig, instruction);
    const prompt = createExtractorPrompt(source, maxFacts, instruction);

    logger.info('extracting', {
      extractor_agent_id: extractorAgentId,
      max_facts: maxFacts,
      source_kind: typeof source,
    });

    let extraction: z.infer<typeof ExtractionSchema>;
    let usage: { totalTokens?: number } | undefined;
    try {
      const result = await generateText({
        model,
        instructions: systemPrompt,
        prompt,
        output: Output.object({ schema: ExtractionSchema }),
        ...(agentConfig.maxOutputTokens !== undefined ? { maxOutputTokens: agentConfig.maxOutputTokens } : {}),
        ...(agentConfig.temperature !== undefined ? { temperature: agentConfig.temperature } : {}),
        ...(agentConfig.providerOptions ? { providerOptions: agentConfig.providerOptions } : {}),
      });
      extraction = result.output;
      usage = result.usage;
    } catch (error) {
      // Same taxonomy as agent/supervisor calls: carry the retryable
      // classification so the runner's retry loop short-circuits a
      // deterministic 400 instead of re-issuing it max_retries times.
      throw new AgentExecutionError(extractorAgentId, error, undefined, classifyRetryable(error));
    }

    const tokensUsed = usage?.totalTokens ?? 0;

    // Trim then clamp to the requested cap — the schema allows up to 50
    // so the LLM can return a few extras, but we always honour the caller's
    // soft cap before returning.
    const facts = extraction.facts
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .slice(0, maxFacts);

    logger.info('extraction_complete', {
      extractor_agent_id: extractorAgentId,
      facts_returned: facts.length,
      tokens_used: tokensUsed,
    });

    span.setAttribute('extractor.facts_returned', facts.length);
    span.setAttribute('extractor.tokens', tokensUsed);

    return {
      facts,
      reasoning: extraction.reasoning,
      tokensUsed,
    };
  });
}
