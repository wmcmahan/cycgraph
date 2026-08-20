/**
 * read_file — a window onto one file in a jailed workspace
 *
 * Line-windowed rather than all-or-nothing: a large file is read in slices
 * (`offset`/`limit`), with a marker saying what was elided and how to get the
 * rest — sized tool results are the difference between editing a two-hundred
 * line file and a three-thousand line one. A hard byte cap still refuses what
 * is not source at all.
 *
 * Every read records the whole file's content hash into the session when one
 * is shared, which is what arms the edit tool's staleness check. Tainted —
 * workspace contents are whoever's repository this is, not the engine's.
 *
 * @module workspace/read-file
 */

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';
import { jailedPath } from './jail.js';
import { contentHash, type WorkspaceSession } from './session.js';

/** Options for {@link readFileTool}. */
export interface ReadFileToolOptions {
  /** The workspace root every path resolves under. */
  root: string;
  /** Session recording what was read, arming the edit tool's staleness check. */
  session?: WorkspaceSession;
  /** Lines returned per call when the caller sets no limit. @default 400 */
  defaultLimit?: number;
  /** Absolute cap on file size in bytes — beyond this is not source. @default 5 MiB */
  maxFileBytes?: number;
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const readFileParameters = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  offset: z.number().int().min(1).optional()
    .describe('1-based line to start from. Defaults to the top of the file.'),
  limit: z.number().int().min(1).optional()
    .describe('How many lines to return. Defaults to the tool’s window size.'),
});

/** Read one file from the workspace, windowed by lines. */
export function readFileTool(options: ReadFileToolOptions): DefinedTool {
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  const defaultLimit = options.defaultLimit ?? 400;

  return defineTool({
    name: 'read_file',
    description: 'Read one file from the workspace by path relative to its root. Large files are windowed: pass offset (1-based line) and limit to read further slices.',
    parameters: readFileParameters,
    taints: true,
    timeoutMs: options.timeoutMs ?? 5000,
    execute: async ({ path, offset, limit }) => {
      const abs = jailedPath(options.root, path);
      const info = await stat(abs);
      if (info.size > maxFileBytes) {
        return `error: '${path}' is ${info.size} bytes, which is not editable source`;
      }

      const contents = await readFile(abs, 'utf8');
      options.session?.seen.set(abs, contentHash(contents));

      const lines = contents.split('\n');
      const start = (offset ?? 1) - 1;
      const window = limit ?? defaultLimit;
      if (start >= lines.length) {
        return `error: '${path}' has ${lines.length} lines; offset ${offset} is past the end`;
      }

      const slice = lines.slice(start, start + window);
      const shown = slice.join('\n');
      if (lines.length <= window && start === 0) return shown;

      const first = start + 1;
      const last = start + slice.length;
      const more = last < lines.length
        ? ` — call again with offset=${last + 1} for the rest`
        : '';
      return `[lines ${first}-${last} of ${lines.length}${more}]\n${shown}`;
    },
  });
}
