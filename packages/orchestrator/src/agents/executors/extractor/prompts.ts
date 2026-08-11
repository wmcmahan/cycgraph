/**
 * Extractor Prompt Construction
 *
 * Builds system and task prompts for the LLM-as-extractor primitive used
 * by the `reflection` node's `llm` variant. All untrusted source content
 * is sanitised before embedding to prevent prompt injection.
 *
 * @module extractor-executor/prompts
 */

import type { AgentConfig } from '../../types.js';
import { sanitizeString } from '../agent/sanitizers.js';

/**
 * Build the task prompt for the extractor, containing the source text to
 * distill into facts.
 */
export function createExtractorPrompt(
  source: unknown,
  max_facts: number,
  instruction?: string,
): string {
  const sourceStr = typeof source === 'string' ? source : JSON.stringify(source, null, 2);
  const sanitizedSource = sanitizeString(sourceStr);
  const sanitizedInstruction = instruction ? sanitizeString(instruction) : undefined;

  return `## Task
${
  sanitizedInstruction ??
  `Distill the SOURCE below into at most ${max_facts} atomic facts.
Each fact must:
- Be a single, self-contained sentence.
- State a generalisable lesson, observation, or rule — not a one-off detail.
- Be useful when retrieved on a future run with similar context.
- Avoid pronouns ("it", "this", "they") and tense markers ("yesterday", "today").`
}

## Source
${sanitizedSource}

Return up to ${max_facts} facts. Fewer is better than padding with weak entries.`;
}

/**
 * Build the system prompt for the extractor agent.
 */
export function createExtractorSystemPrompt(agentConfig: AgentConfig, instruction?: string): string {
  // When the caller supplies a custom instruction, the agent's configured
  // system prompt still bounds the behaviour — we append the role hint
  // and let the task prompt's instruction body take over from there.
  return `${agentConfig.system}

## Your Role
You are a fact extractor. Convert source text into atomic, reusable facts.
${instruction ? '\nThe operator supplied a custom extraction instruction — follow it in the task prompt.\n' : ''}`;
}
