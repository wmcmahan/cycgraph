/**
 * deliver — commit, push, and reply.
 *
 * A tool node running push_revision. It reads the gathered feedback (for
 * the branch and the reply targets) and the reviser's report, and updates
 * the PR in place.
 *
 * @module maintenance/pr-revise/nodes/deliver
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviseTools } from '../tools/index.js';
import type { gatherNode } from './gather.js';

/** The push_revision tool node, reading gather's result and the revise report. */
export function deliverNode(tools: ReviseTools, gather: ReturnType<typeof gatherNode>) {
  return node({
    id: 'deliver',
    type: 'tool',
    toolId: 'push_revision',
    tools: [tools.deliver],
    reads: [gather.result, 'revise_report'],
  });
}
