/**
 * pick — the run's entry node: choose the approved ticket and lift its diff.
 *
 * @module maintenance/optimization-apply/nodes/pick
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';

/** The pick_ticket tool node. */
export function pickNode(tools: OptApplyTools) {
  return node({
    id: 'pick',
    type: 'tool',
    toolId: 'pick_ticket',
    tools: [tools.pick],
    reads: []
  });
}
