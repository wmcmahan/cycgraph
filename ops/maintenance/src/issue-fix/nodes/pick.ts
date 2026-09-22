/**
 * pick — the run's entry node.
 *
 * A tool node running pick_issue: it chooses the issue (or detached key)
 * to fix, and its result decides whether the run has work.
 *
 * @module maintenance/issue-fix/nodes/pick
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';

/** The pick_issue tool node. */
export function pickNode(tools: IssueFixTools) {
  return node({ id: 'pick', type: 'tool', toolId: 'pick_issue', tools: [tools.pick], reads: [] });
}
