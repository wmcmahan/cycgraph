/**
 * Prompt candidate generation
 *
 * The one model call in the tuning loop that is not a fork. It takes the
 * brief `@cycgraph/evals` renders and returns whatever the model said, raw:
 * sanitisation and sweep-building stay in the evals package, so what a
 * candidate must survive is decided by tested pure code rather than by
 * whoever wrote this adapter.
 *
 * Talks to Ollama directly rather than through the engine, because this is
 * not workflow execution: no state, no taint, no budget — a single
 * completion whose output is about to be measured by twenty-five forks that
 * do not care where it came from.
 *
 * @module improve/prompts
 */

import type { Stack } from '../stack/index.js';

/** Sampling temperature for candidate generation. Diversity is the point. */
const GENERATION_TEMPERATURE = 0.9;

/**
 * Ask the stack's model for prompt candidates.
 *
 * Returns the parsed JSON, whatever its shape — the caller's sanitiser owns
 * deciding what of it survives. Throws on transport or parse failure, and the
 * caller reports that as why no prompt sweep ran rather than crashing the
 * pass.
 */
export async function generatePromptCandidates(
  stack: Stack,
  instructions: string,
): Promise<unknown> {
  const response = await fetch(`${stack.config.endpoints.ollama}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: stack.config.model,
      messages: [{ role: 'user', content: instructions }],
      stream: false,
      format: 'json',
      options: { temperature: GENERATION_TEMPERATURE },
    }),
  });
  if (!response.ok) {
    throw new Error(`prompt generation failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as { message?: { content?: string } };
  const content = body.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('prompt generation returned no content');
  }
  return JSON.parse(content) as unknown;
}
