/**
 * checks — the gate's full check run over the fix.
 *
 * A tool node running repo_checks (a no-op when local checks are off or
 * none are configured). Its result feeds the gate.
 *
 * @module maintenance/issue-fix/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: IssueFixTools) {
  return node({
    id: 'checks',
    type: 'tool',
    toolId: 'repo_checks',
    tools: [tools.checks],
    reads: []
  });
}
