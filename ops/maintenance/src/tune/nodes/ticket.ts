/**
 * ticket — file the winning proposal as a ticket.
 *
 * @module maintenance/tune/nodes/ticket
 */

import { node } from '@cycgraph/orchestrator';
import type { TuneTools } from '../tools/index.js';
import type { shapeNode } from './shape.js';
import type { trialNode } from './trial.js';

/** The file_ticket tool node, reading the shaped edit and the trial result. */
export function ticketNode(
  tools: TuneTools,
  shape: ReturnType<typeof shapeNode>,
  trial: ReturnType<typeof trialNode>,
) {
  return node({ id: 'ticket', type: 'tool', toolId: 'file_ticket', tools: [tools.ticket], reads: [shape.result, trial.result] });
}
