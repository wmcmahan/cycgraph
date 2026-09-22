/**
 * give_up — flag the picked ticket's issue when no PR can be delivered.
 *
 * Reached when the reviewer never approves within the round budget. A
 * detached run has no issue to flag.
 *
 * @module maintenance/implement-ticket/tools/give-up
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { giveUpNeedsHuman } from '../../shared/repo.js';
import type { ImplementContext } from '../context.js';

/** The give-up tool, bound to the run's context. */
export function giveUpTool(c: ImplementContext) {
  const { repoRoot, token, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'give_up',
    description: 'Flag the picked ticket\'s issue as waiting on a human when the run cannot deliver a pull request.',
    parameters: z.object({ pick_result: z.unknown().optional(), review_check_result: z.unknown().optional() }),
    timeoutMs: 60_000,
    execute: async ({ pick_result, review_check_result }) => {
      const issue = (pick_result as { issue_number?: number } | undefined)?.issue_number;
      if (issue === undefined) return { flagged: false, detail: 'detached run — nothing to flag' };
      const review = review_check_result as { round?: number } | undefined;
      const cause = `the reviewer never approved after ${String(review?.round ?? 0)} round(s)`;
      return giveUpNeedsHuman(repoRoot, issue, 'implement-ticket', cause, ctx.labels.needsHuman, auth);
    },
  });
}
