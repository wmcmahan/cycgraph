/**
 * The auditor's hands and the run's tool-node primitives.
 *
 * `hands` are the read-only search/read tools each auditor drives; the tool
 * nodes are `clone` (which also cuts the charter list), `sift`, and
 * `ticket`. Each is its own file; this barrel binds them all to one
 * {@link RepoAuditContext}.
 *
 * @module maintenance/repo-audit/tools
 */

import type { RepoAuditContext } from '../context.js';
import { repoAuditHands } from './hands.js';
import { cloneTool } from './clone.js';
import { siftTool } from './sift.js';
import { ticketTool } from './ticket.js';

/** Build every tool the run needs, bound to the given context. */
export function repoAuditTools(c: RepoAuditContext) {
  return {
    hands: repoAuditHands(c),
    clone: cloneTool(c),
    sift: siftTool(c),
    ticket: ticketTool(c),
  };
}

/** The auditor's hands and the run's tool-node primitives. */
export type RepoAuditTools = ReturnType<typeof repoAuditTools>;
