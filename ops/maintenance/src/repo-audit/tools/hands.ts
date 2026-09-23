/**
 * The auditor's read-only hands: search and read.
 *
 * Every auditor's hands are search and read only — nothing is edited.
 *
 * @module maintenance/repo-audit/tools/hands
 */

import { readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { RepoAuditContext } from '../context.js';

/** The two read-only workspace tools, bound to the clone. */
export function repoAuditHands(c: RepoAuditContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
  };
}
