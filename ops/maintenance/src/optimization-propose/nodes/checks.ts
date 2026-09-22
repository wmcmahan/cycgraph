/**
 * checks — the gate's check run over the proposal.
 *
 * @module maintenance/optimization-propose/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { OptProposeTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: OptProposeTools) {
  return node({
    id: 'checks',
    type: 'tool',
    toolId: 'repo_checks',
    tools: [tools.checks],
    reads: []
  });
}
