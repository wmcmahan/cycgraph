/**
 * verdict — parse the review into a decision.
 *
 * A tool node running review_verdict: it reads the review and the prior
 * verdict result (to increment the round) and produces the verdict the
 * edges branch on — approve, revise, or malformed.
 *
 * @module maintenance/pr-review/nodes/verdict
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviewTools } from '../tools/index.js';

/** The review_verdict tool node. */
export function verdictNode(tools: ReviewTools) {
  return node({
    id: 'verdict',
    type: 'tool',
    toolId: 'review_verdict',
    tools: [tools.verdict],
    reads: ['review', 'verdict_result']
  });
}
