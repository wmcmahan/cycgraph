/**
 * Evaluator Prompt Construction
 *
 * Builds system and task prompts for the LLM-as-judge evaluator.
 * All untrusted content (goal text, agent output) is sanitized before
 * embedding to prevent prompt injection.
 *
 * @module agents/executors/evaluator/prompts
 */

import type { AgentConfig } from '../../types.js';
import { sanitizeString } from '../agent/sanitizers.js';

/**
 * Build the task prompt for the evaluator, containing the goal and
 * the output to be evaluated.
 *
 * @param goal - The original workflow goal the output was generated for.
 * @param output - The agent output to evaluate (string or serialisable object).
 * @returns The assembled task prompt string.
 */
export function createEvaluatorPrompt(goal: string, output: unknown): string {
  const sanitizedGoal = sanitizeString(goal);
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const sanitizedOutput = sanitizeString(outputStr);

  return `## Goal
${sanitizedGoal}

## Output to Evaluate
${sanitizedOutput}

Evaluate the quality of this output relative to the goal. Provide a score, reasoning, and suggestions for improvement.`;
}

/**
 * Build the system prompt for the evaluator agent.
 *
 * Combines the agent's configured system prompt with role instructions,
 * optional evaluation criteria, and a scoring rubric.
 *
 * @param agentConfig - The evaluator agent's configuration record.
 * @param criteria - Optional domain-specific evaluation criteria.
 * @returns The assembled system prompt string.
 */
export function createEvaluatorSystemPrompt(agentConfig: AgentConfig, criteria?: string): string {
  const sanitizedCriteria = criteria ? sanitizeString(criteria) : '';

  return `${agentConfig.system}

## Your Role
You are a quality evaluator. Score the output on a scale from 0.0 (terrible) to 1.0 (perfect).
${sanitizedCriteria ? `\n## Evaluation Criteria\n${sanitizedCriteria}` : ''}

## Scoring Guidelines
- 0.0-0.2: Completely wrong or irrelevant
- 0.2-0.4: Partially correct but major issues
- 0.4-0.6: Acceptable but needs improvement
- 0.6-0.8: Good quality, minor issues
- 0.8-1.0: Excellent, meets or exceeds expectations`;
}
