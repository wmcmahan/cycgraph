/**
 * ticket — file the verified proposal as an issue.
 *
 * @module maintenance/optimization-propose/nodes/ticket
 */

import { node } from '@cycgraph/orchestrator';
import type { OptProposeTools } from '../tools/index.js';
import type { verdictNode } from './verdict.js';

/** The file_ticket tool node, reading the verdict and the proposal. */
export function ticketNode(tools: OptProposeTools, verdict: ReturnType<typeof verdictNode>) {
  return node({
    id: 'ticket',
    type: 'tool',
    toolId: 'file_ticket',
    tools: [tools.ticket],
    reads: [verdict.result, 'proposal'],
  });
}
