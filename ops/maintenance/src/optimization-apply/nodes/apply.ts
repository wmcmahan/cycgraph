/**
 * apply — re-apply the ticket's verified diff to the clone.
 *
 * @module maintenance/optimization-apply/nodes/apply
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';
import type { pickNode } from './pick.js';

/** The apply_diff tool node, reading pick's diff. */
export function applyNode(tools: OptApplyTools, pick: ReturnType<typeof pickNode>) {
  return node({
    id: 'apply',
    type: 'tool',
    toolId: 'apply_diff',
    tools: [tools.apply],
    reads: [pick.result]
  });
}
