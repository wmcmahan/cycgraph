/**
 * review_fallback — the diff-only retry.
 *
 * An agent node running the toolless fallback reviewer, entered when the
 * first review came back with no verdict. Reads the same brief and the
 * prior verdict result, and writes the review.
 *
 * @module maintenance/pr-review/nodes/review-fallback
 */

import { node } from '@cycgraph/orchestrator';
import type { reviewerFallbackAgent } from '../agents/reviewer-fallback.js';
import type { gatherNode } from './gather.js';

/** The diff-only fallback reviewer node. */
export function reviewFallbackNode(
  reviewerFallback: ReturnType<typeof reviewerFallbackAgent>,
  gather: ReturnType<typeof gatherNode>,
) {
  return node({
    id: 'review_fallback',
    agent: reviewerFallback,
    failurePolicy: { timeoutMs: 300_000 },
    reads: [gather.result, 'verdict_result'],
    writes: 'review',
  });
}
