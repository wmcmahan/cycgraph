/**
 * edit_file — one exact replacement in one jailed file
 *
 * Two refusals, both the harness's discipline rather than the model's memory.
 * The unique-match refusal: a `find` that is absent or ambiguous changes
 * nothing and says why, so an agent must bring more context rather than the
 * tool guessing where an edit half-fits. The staleness refusal, when a
 * session is shared: a file that was never read — or whose content changed
 * since it was read — is not edited from a stale picture; the agent is told
 * to read it again. A successful edit records the new content as read, so an
 * agent iterating on one file is not sent back to re-read its own work.
 *
 * This is the same primitive frontier coding agents edit with — capability
 * lives in the loop driving it, not in a cleverer pen.
 *
 * @module workspace/edit-file
 */

import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';
import { jailedPath } from './jail.js';
import { contentHash, type WorkspaceSession } from './session.js';

/** Options for {@link editFileTool}. */
export interface EditFileToolOptions {
  /** The workspace root every path resolves under. */
  root: string;
  /**
   * Session shared with the read tool. When present, editing requires a
   * prior read of the same content; when absent, the discipline is off.
   */
  session?: WorkspaceSession;
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const editFileParameters = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  find: z.string().min(1).describe('Exact snippet to replace; must appear exactly once.'),
  replace: z.string().describe('What the snippet becomes.'),
});

/** Replace one exact, unique snippet in one workspace file. */
export function editFileTool(options: EditFileToolOptions): DefinedTool {
  return defineTool({
    name: 'edit_file',
    description: 'Replace one exact snippet in one file. The find text must appear exactly once, and the file must have been read first; otherwise the edit is refused and nothing changes.',
    parameters: editFileParameters,
    timeoutMs: options.timeoutMs ?? 5000,
    execute: async ({ path, find, replace }) => {
      const abs = jailedPath(options.root, path);
      const source = await readFile(abs, 'utf8');

      if (options.session) {
        const seen = options.session.seen.get(abs);
        if (!seen) {
          return `error: read '${path}' before editing it`;
        }
        if (seen !== contentHash(source)) {
          return `error: '${path}' changed since it was read — read it again`;
        }
      }

      const first = source.indexOf(find);
      if (first < 0) {
        return `error: the find text does not appear in '${path}' — read the file and use an exact snippet`;
      }
      if (source.indexOf(find, first + 1) >= 0) {
        return `error: the find text appears more than once in '${path}' — include more surrounding context`;
      }

      const next = source.slice(0, first) + replace + source.slice(first + find.length);
      await writeFile(abs, next);
      options.session?.seen.set(abs, contentHash(next));
      return `edited '${path}'`;
    },
  });
}
