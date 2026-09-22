/**
 * checks — the gate's check run over the re-applied change.
 *
 * @module maintenance/optimization-apply/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: OptApplyTools) {
  return node({
    id: 'checks',
    type: 'tool',
    toolId: 'repo_checks',
    tools: [tools.checks],
    reads: []
  });
}
