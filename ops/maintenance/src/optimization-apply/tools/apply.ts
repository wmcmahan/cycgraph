/**
 * apply_diff — apply the ticket's verified diff to the workspace.
 *
 * A diff that no longer applies is reported honestly (not retried): the
 * remedy is a fresh optimization-propose run, not a force.
 *
 * @module maintenance/optimization-apply/tools/apply
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import type { OptApplyContext } from '../context.js';

const exec = promisify(execFile);

/** The diff-applying tool, bound to the clone. */
export function applyTool(c: OptApplyContext) {
  const { workspaceAt } = c;
  return tool({
    name: 'apply_diff',
    description: 'Apply the ticket\'s verified diff to the workspace.',
    parameters: z.object({ pick_result: z.unknown().optional() }),
    timeoutMs: 60_000,
    execute: async ({ pick_result }) => {
      const diff = (pick_result as { diff?: string } | undefined)?.diff ?? '';
      const patchAt = join(tmpdir(), `cycgraph-optimization-apply-${randomUUID()}.patch`);
      await writeFile(patchAt, diff.endsWith('\n') ? diff : `${diff}\n`);
      try {
        await exec('git', ['apply', '--whitespace=nowarn', patchAt], { cwd: workspaceAt });
        return { applied: true };
      } catch (error) {
        return {
          applied: false,
          detail: `the diff no longer applies to the current tree — re-propose: ${(error as Error).message.split('\n')[0]}`,
        };
      }
    },
  });
}
