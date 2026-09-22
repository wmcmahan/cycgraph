/**
 * The fixer's editing surface: search, read, edit, create.
 *
 * The workspace file tools the fixer drives directly, each scoped to the
 * fresh clone and sharing one session so edits see prior reads' bytes.
 *
 * @module maintenance/issue-fix/tools/hands
 */

import {
  createFileTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import type { IssueFixContext } from '../context.js';

/** The four workspace-editing tools, bound to the clone. */
export function issueFixHands(c: IssueFixContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
    edit: editFileTool({ root: workspaceAt, session }),
    create: createFileTool({ root: workspaceAt, session }),
  };
}
