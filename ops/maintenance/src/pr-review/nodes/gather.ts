/**
 * gather — the run's entry node.
 *
 * A tool node running gather_pr: it checks out the PR and assembles the
 * review brief, and its result decides whether the run has work or routes
 * straight to report.
 *
 * @module maintenance/pr-review/nodes/gather
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviewTools } from '../tools/index.js';

/** The gather_pr tool node. */
export function gatherNode(tools: ReviewTools) {
  return node({
    id: 'gather',
    type: 'tool',
    toolId: 'gather_pr',
    tools: [tools.gather],
    reads: []
  });
}
