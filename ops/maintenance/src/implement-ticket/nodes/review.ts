/**
 * review — the advisory reviewer at work.
 *
 * @module maintenance/implement-ticket/nodes/review
 */

import { node } from '@cycgraph/orchestrator';
import type { reviewerAgent } from '../agents/reviewer.js';
import type { pickNode } from './pick.js';
import type { diffNode } from './diff.js';

/** The advisory reviewer node, reading the ticket and the diff. */
export function reviewNode(
  reviewer: ReturnType<typeof reviewerAgent>,
  pick: ReturnType<typeof pickNode>,
  diff: ReturnType<typeof diffNode>,
) {
  return node({
    id: 'review',
    agent: reviewer,
    failurePolicy: { timeoutMs: 300_000 },
    reads: [pick.result, diff.result],
    writes: 'review',
  });
}
