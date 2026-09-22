/**
 * The implementer's editing surface: search, read, edit, create.
 *
 * @module maintenance/implement-ticket/tools/hands
 */

import {
  createFileTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import type { ImplementContext } from '../context.js';

/** The four workspace-editing tools, bound to the clone. */
export function implementHands(c: ImplementContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
    edit: editFileTool({ root: workspaceAt, session }),
    create: createFileTool({ root: workspaceAt, session }),
  };
}
