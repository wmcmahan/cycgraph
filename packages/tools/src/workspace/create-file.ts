/**
 * create_file — one new file in a jailed workspace
 *
 * The write hand that brings a file into existence, and deliberately only
 * that. A path that already exists is refused rather than overwritten, so
 * the read-before-edit invariant the edit tool holds cannot be routed
 * around by clobbering a file nobody read; changing existing text stays
 * edit_file's job, with its unique-match and staleness refusals intact.
 *
 * The security story is the same as the rest of the surface: every path
 * resolves through the jail, so parent directories are created under the
 * root or not at all, and a byte cap keeps a write hand from becoming a way
 * to fill a disk. A successful create records the new content as read, so an
 * agent may immediately edit the file it just wrote rather than being sent
 * back to read its own text.
 *
 * @module workspace/create-file
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';
import { jailedPath } from './jail.js';
import { contentHash, type WorkspaceSession } from './session.js';

/** Options for {@link createFileTool}. */
export interface CreateFileToolOptions {
  /** The workspace root every path resolves under. */
  root: string;
  /**
   * Session shared with the read and edit tools. A created file is recorded
   * as read, so an agent can edit its own new file without re-reading it.
   */
  session?: WorkspaceSession;
  /** Largest file this tool will write, in bytes. @default 1 MiB */
  maxFileBytes?: number;
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const createFileParameters = z.object({
  path: z.string().describe('Path of the new file, relative to the workspace root.'),
  contents: z.string().describe('The complete contents of the new file.'),
});

/** Whether anything already occupies the path — a directory counts. */
async function occupied(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Create one new file in the workspace, refusing to overwrite. */
export function createFileTool(options: CreateFileToolOptions): DefinedTool {
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;

  return defineTool({
    name: 'create_file',
    description: 'Create one new file at a path relative to the workspace root, with the given contents. Parent directories are created as needed. Refuses to overwrite an existing path — use edit_file to change a file that already exists.',
    parameters: createFileParameters,
    // Not tainting: the only thing this tool reports back is a confirmation
    // of the agent's own text, never workspace contents it has not supplied.
    taints: false,
    timeoutMs: options.timeoutMs ?? 5000,
    execute: async ({ path, contents }) => {
      const abs = jailedPath(options.root, path);

      const bytes = Buffer.byteLength(contents, 'utf8');
      if (bytes > maxFileBytes) {
        return `error: '${path}' would be ${bytes} bytes, over the ${maxFileBytes} byte write limit`;
      }

      if (await occupied(abs)) {
        return `error: '${path}' already exists — use edit_file to change it`;
      }

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, { flag: 'wx' });
      options.session?.seen.set(abs, contentHash(contents));
      return `created '${path}'`;
    },
  });
}
