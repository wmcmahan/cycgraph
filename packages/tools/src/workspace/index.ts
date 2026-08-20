/**
 * Workspace tools: a code-editing agent's hands
 *
 * Read, search, and edit over one jailed directory, plus a caller-configured
 * diagnostics probe — the whole surface an editor agent gets, and its
 * narrowness is the security story. The workspace is a disposable clone,
 * never the host; branching, verifying, and committing are procedures that
 * belong to the caller, not the model.
 *
 * The bundle shares one session between read and edit, which is what
 * enforces read-before-edit and staleness refusal as harness discipline
 * rather than model memory.
 *
 * @module workspace
 */

export { jailedPath, WorkspaceEscapeError } from './jail.js';
export { createWorkspaceSession, contentHash } from './session.js';
export type { WorkspaceSession } from './session.js';
export { readFileTool, readFileParameters } from './read-file.js';
export type { ReadFileToolOptions } from './read-file.js';
export { searchTool, searchParameters } from './search.js';
export type { SearchToolOptions } from './search.js';
export { editFileTool, editFileParameters } from './edit-file.js';
export type { EditFileToolOptions } from './edit-file.js';
export { diagnosticsTool, diagnosticsParameters } from './diagnostics.js';
export type { DiagnosticsToolOptions, DiagnosticsResult } from './diagnostics.js';

import type { DefinedTool } from '@cycgraph/orchestrator';
import { editFileTool } from './edit-file.js';
import { readFileTool } from './read-file.js';
import { searchTool } from './search.js';
import { createWorkspaceSession } from './session.js';

/**
 * The full editor surface over one workspace root, with the read/edit
 * discipline armed by a shared session.
 */
export function workspaceTools(root: string): DefinedTool[] {
  const session = createWorkspaceSession();
  return [
    searchTool({ root }),
    readFileTool({ root, session }),
    editFileTool({ root, session }),
  ];
}
