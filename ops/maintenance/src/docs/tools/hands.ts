/**
 * The fixer's editing surface: search, read, edit.
 *
 * @module maintenance/docs/tools/hands
 */

import { editFileTool, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { DocsContext } from '../context.js';

/** The three workspace-editing tools, bound to the clone. */
export function docsHands(c: DocsContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
    edit: editFileTool({ root: workspaceAt, session }),
  };
}
