/**
 * accept — run the ticket's acceptance criteria.
 *
 * @module maintenance/implement-ticket/nodes/accept
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';
import type { pickNode } from './pick.js';

/** The run_acceptance tool node, reading the picked ticket. */
export function acceptNode(tools: ImplementTools, pick: ReturnType<typeof pickNode>) {
  return node({ id: 'accept', type: 'tool', toolId: 'run_acceptance', tools: [tools.accept], reads: [pick.result] });
}
