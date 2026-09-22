/**
 * review — the reviewer at work.
 *
 * The agent node. It reads the gathered brief and the last verdict result
 * (so a retry sees "carries no VERDICT marker" and does not repeat the
 * same unusable output) and writes the review. Draws the pr-review lesson
 * pool when memory is on.
 *
 * @module maintenance/pr-review/nodes/review
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviewContext } from '../context.js';
import type { reviewerAgent } from '../agents/reviewer.js';
import type { gatherNode } from './gather.js';

/** The reviewer agent node, reading gather's result and the prior verdict. */
export function reviewNode(
  c: ReviewContext,
  reviewer: ReturnType<typeof reviewerAgent>,
  gather: ReturnType<typeof gatherNode>,
) {
  return node({
    id: 'review',
    agent: reviewer,
    failurePolicy: { timeoutMs: 1_200_000 },
    reads: [gather.result, 'verdict_result'],
    writes: 'review',
    ...(c.env.memory ? { memoryQuery: { tags: ['wf:pr-review'], maxFacts: 6 } } : {}),
  });
}
