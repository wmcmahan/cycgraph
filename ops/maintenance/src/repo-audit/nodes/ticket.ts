/**
 * ticket — file the shortlisted findings as issues.
 *
 * @module maintenance/repo-audit/nodes/ticket
 */

import { node } from '@cycgraph/orchestrator';
import type { RepoAuditTools } from '../tools/index.js';
import type { siftNode } from './sift.js';

/** The file_tickets tool node, reading the sift result. */
export function ticketNode(tools: RepoAuditTools, sift: ReturnType<typeof siftNode>) {
  return node({ id: 'ticket', type: 'tool', toolId: 'file_tickets', tools: [tools.ticket], reads: [sift.result] });
}
