/**
 * giveup — the graph's dead-end handler.
 *
 * A tool node running give_up, reached when the reviewer never approves.
 *
 * @module maintenance/implement-ticket/nodes/give-up
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';
import type { pickNode } from './pick.js';

/** The give_up tool node, reading the ticket and the review-check result. */
export function giveUpNode(tools: ImplementTools, pick: ReturnType<typeof pickNode>) {
  return node({ id: 'giveup', type: 'tool', toolId: 'give_up', tools: [tools.giveUp], reads: [pick.result, 'review_check_result'] });
}
