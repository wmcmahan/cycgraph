/**
 * ticket — file the well-formed proposal as an issue.
 *
 * @module maintenance/feature-propose/nodes/ticket
 */

import { node } from '@cycgraph/orchestrator';
import type { FeatProposeTools } from '../tools/index.js';
import type { shapeNode } from './shape.js';

/** The file_ticket tool node, reading the shape result and the proposal. */
export function ticketNode(tools: FeatProposeTools, shape: ReturnType<typeof shapeNode>) {
  return node({
    id: 'ticket',
    type: 'tool',
    toolId: 'file_ticket',
    tools: [tools.ticket],
    reads: [shape.result, 'proposal'],
  });
}
