/**
 * give_up — flag the picked ticket's issue when no PR can be delivered.
 *
 * Two causes: the approved diff no longer applies, or the improvement no
 * longer measures (or a check regressed). A detached run has no issue to
 * flag.
 *
 * @module maintenance/optimization-apply/tools/give-up
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { giveUpNeedsHuman } from '../../shared/repo.js';
import type { OptApplyContext } from '../context.js';

/** The give-up tool, bound to the run's context. */
export function giveUpTool(c: OptApplyContext) {
  const { repoRoot, token, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'give_up',
    description: 'Flag the picked optimization ticket\'s issue as waiting on a human when the run cannot deliver a pull request.',
    parameters: z.object({ pick_result: z.unknown().optional(), apply_result: z.unknown().optional() }),
    timeoutMs: 60_000,
    execute: async ({ pick_result, apply_result }) => {
      const issue = (pick_result as { issue_number?: number } | undefined)?.issue_number;
      if (issue === undefined) return { flagged: false, detail: 'detached run — nothing to flag' };
      const applied = (apply_result as { applied?: boolean } | undefined)?.applied === true;
      const cause = applied
        ? 'the optimization no longer measures a win or a repository check regressed'
        : 'the approved diff no longer applies cleanly and needs a fresh proposal';
      return giveUpNeedsHuman(repoRoot, issue, 'optimization-apply', cause, ctx.labels.needsHuman, auth);
    },
  });
}
