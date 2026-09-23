/**
 * pick — the run's entry node: choose and parse the approved ticket.
 *
 * @module maintenance/implement-ticket/nodes/pick
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';

/** The pick_ticket tool node. */
export function pickNode(tools: ImplementTools) {
  return node({ id: 'pick', type: 'tool', toolId: 'pick_ticket', tools: [tools.pick], reads: [] });
}
