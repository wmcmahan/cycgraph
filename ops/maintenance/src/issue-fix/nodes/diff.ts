/**
 * diff — the fix diff, for the reviewer.
 *
 * A tool node running workspace_diff, entered after the gate passes.
 *
 * @module maintenance/issue-fix/nodes/diff
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';

/** The workspace_diff tool node. */
export function diffNode(tools: IssueFixTools) {
  return node({
    id: 'diff',
    type: 'tool',
    toolId: 'workspace_diff',
    tools: [tools.diff],
    reads: []
  });
}
