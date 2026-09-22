/**
 * checks — the revision's read-only verification.
 *
 * A tool node running repo_checks: the repository's own checks over the
 * revised tree, refusing any mutation. Its result feeds the gate.
 *
 * @module maintenance/pr-revise/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { ReviseTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: ReviseTools) {
  return node({
    id: 'checks',
    type: 'tool',
    toolId: 'repo_checks',
    tools: [tools.checks],
    reads: [],
  });
}
