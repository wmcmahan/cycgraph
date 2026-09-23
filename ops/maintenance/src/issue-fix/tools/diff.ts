/**
 * workspace_diff — the clone's uncommitted diff, for the reviewer.
 *
 * @module maintenance/issue-fix/tools/diff
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { pendingDiff } from '@cycgraph/tools/git';
import type { IssueFixContext } from '../context.js';

/** The uncommitted-diff tool, bound to the clone. */
export function diffTool(c: IssueFixContext) {
  const { workspaceAt } = c;
  return tool({
    name: 'workspace_diff',
    description: 'The workspace\'s full uncommitted diff, for review.',
    parameters: z.object({}),
    execute: async () => {
      const diff = await pendingDiff(workspaceAt);
      return { diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (truncated)` : diff };
    },
  });
}
