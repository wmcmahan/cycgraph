/**
 * The optimizer's editing surface: search, read, edit.
 *
 * The workspace file tools the optimizer drives directly. No create hand:
 * an optimization edits existing hot paths, it does not add files.
 *
 * @module maintenance/optimization-propose/tools/hands
 */

import { editFileTool, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { OptProposeContext } from '../context.js';

/** The three workspace-editing tools, bound to the clone. */
export function optProposeHands(c: OptProposeContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
    edit: editFileTool({ root: workspaceAt, session }),
  };
}
