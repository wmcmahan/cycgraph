/**
 * deliver — submit the review on the PR.
 *
 * A tool node running post_review. It reads the review, the verdict, and
 * the gathered brief (for labels, rounds, and the threads to resolve).
 *
 * @module maintenance/pr-review/nodes/deliver
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviewTools } from '../tools/index.js';
import type { verdictNode } from './verdict.js';
import type { gatherNode } from './gather.js';

/** The post_review tool node, reading the review, verdict, and brief. */
export function deliverNode(
  tools: ReviewTools,
  verdict: ReturnType<typeof verdictNode>,
  gather: ReturnType<typeof gatherNode>,
) {
  return node({
    id: 'deliver',
    type: 'tool',
    toolId: 'post_review',
    tools: [tools.deliver],
    reads: ['review', verdict.result, gather.result],
  });
}
