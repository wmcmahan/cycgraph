/**
 * The reviser's editing surface: search, read, edit, create.
 *
 * These are the workspace file tools the agent drives directly, each
 * scoped to the fresh clone at {@link ReviseContext.workspaceAt} and
 * sharing one {@link WorkspaceSession} so edits see prior reads' bytes.
 *
 * @module maintenance/pr-revise/tools/hands
 */

import {
  createFileTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import type { ReviseContext } from '../context.js';

/** The four workspace-editing tools, bound to the clone. */
export function reviseHands(c: ReviseContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
    edit: editFileTool({ root: workspaceAt, session }),
    create: createFileTool({ root: workspaceAt, session }),
  };
}
