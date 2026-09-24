/**
 * The lesson distiller: the cross-run learning tail.
 *
 * The `reflect` node's LLM extractor. It distills one review into
 * transferable lessons for the agents that write and review future
 * maintenance PRs. See the docs workflow for the pattern.
 *
 * @module maintenance/pr-review/agents/distiller
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { ReviewContext } from '../context.js';

/** Build the review lesson-distiller agent (no tools; used by `reflect`). */
export function distillerAgent(c: ReviewContext) {
  const { env } = c;
  return agent({
    id: 'pr-review-lesson-distiller',
    name: 'Review lesson distiller',
    model: modelFor(env, 'low'),
    modelPreference: 'low',
    effort: 'low',
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 1,
    instructions: [
      'You distill one pull-request review into transferable lessons for the agents that write and review future maintenance PRs.',
      'A lesson is one present-tense sentence about a recurring defect class or convention miss that would change how the NEXT change is written or reviewed.',
      'Never include run-specific details (PR numbers, branch names, file paths). Return no facts when nothing transferable appeared.',
    ].join(' '),
  });
}
