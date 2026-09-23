/**
 * giveup — the graph's dead-end handler.
 *
 * A tool node running give_up. A diff that no longer applies, or an
 * improvement that no longer measures, routes here and flags the ticket's
 * issue needs-human.
 *
 * @module maintenance/optimization-apply/nodes/give-up
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';
import type { pickNode } from './pick.js';
import type { applyNode } from './apply.js';

/** The give_up tool node, reading the ticket and the apply result. */
export function giveUpNode(
  tools: OptApplyTools,
  pick: ReturnType<typeof pickNode>,
  apply: ReturnType<typeof applyNode>,
) {
  return node({
    id: 'giveup',
    type: 'tool',
    toolId: 'give_up',
    tools: [tools.giveUp],
    reads: [pick.result, apply.result]
  });
}
