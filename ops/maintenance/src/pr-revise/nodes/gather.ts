/**
 * gather — the run's entry node.
 *
 * A tool node running gather_feedback: it reads the review and checks out
 * the branch, and its result decides whether the run has work or routes
 * straight to report.
 *
 * @module maintenance/pr-revise/nodes/gather
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviseTools } from '../tools/index.js';

/** The gather_feedback tool node. */
export function gatherNode(tools: ReviseTools) {
  return node({
    id: 'gather',
    type: 'tool',
    toolId: 'gather_feedback',
    tools: [tools.gather],
    reads: [],
  });
}
