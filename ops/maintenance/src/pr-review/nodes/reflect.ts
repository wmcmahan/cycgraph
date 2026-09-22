/**
 * reflect — the cross-run learning tail.
 *
 * A reflection node that distills the review into candidate lessons via
 * the distiller agent. Present only when memory is wired; without it the
 * node is absent and the graph runs deliver → report.
 *
 * @module maintenance/pr-review/nodes/reflect
 */

import { reflection } from '@cycgraph/orchestrator';
import { CANDIDATE_TAG, LESSON_TAG, MAINT_TAG } from '../../shared/memory.js';
import type { ReviewContext } from '../context.js';
import type { distillerAgent } from '../agents/distiller.js';

/** The reflection node, or `undefined` when memory is off. */
export function reflectNode(c: ReviewContext, distiller: ReturnType<typeof distillerAgent>) {
  if (!c.env.memory) return undefined;
  return reflection(['review'], {
    id: 'reflect',
    reads: ['review'],
    failurePolicy: { maxRetries: 2 },
    extractor: { type: 'llm', agentId: distiller, maxFacts: 2 },
    tags: [LESSON_TAG, MAINT_TAG, 'wf:pr-review', CANDIDATE_TAG],
  });
}
