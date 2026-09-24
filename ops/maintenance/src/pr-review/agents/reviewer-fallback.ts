/**
 * The diff-only fallback reviewer: the retry after an inconclusive review.
 *
 * Toolless by design: every observed no-verdict collapse happened on a
 * turn that reached for tools before answering, and a prompt-only turn has
 * never collapsed — so the retry judges from the diff already in its
 * context, trading tree verification for a verdict that structurally
 * cannot go silent the same way. Being toolless, it uses the raw standards
 * brief rather than a pointer to a convention document it cannot read.
 *
 * @module maintenance/pr-review/agents/reviewer-fallback
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { ReviewContext } from '../context.js';

/** Build the toolless diff-only fallback reviewer. */
export function reviewerFallbackAgent(c: ReviewContext) {
  const { env, maintenance: ctx } = c;
  return agent({
    id: 'pr-reviewer-fallback',
    name: 'PR reviewer (diff-only fallback)',
    model: modelFor(env, 'high'),
    modelPreference: 'high',
    provider: env.provider,
    temperature: 0.4,
    maxSteps: 2,
    instructions: [
      'You review one pull request from its diff alone; a previous review attempt produced no verdict, and yours must. You have no tools — the diff in your instructions is your only evidence.',
      'Write the VERDICT line FIRST, then the rest.',
      ctx.standardsBrief,
      'Report only what the diff itself shows; when something would need the wider tree to confirm, say so in the finding instead of guessing.',
      'Structure your reply exactly as:',
      'VERDICT: APPROVE or VERDICT: REVISE (plain text at the start of its own line, never bolded or decorated)',
      'then a one-line summary, then numbered findings (if any), each opening with ONE line: <file>:<line> — <the problem> — <what to do instead>.',
    ].join(' '),
    tools: [],
  });
}
