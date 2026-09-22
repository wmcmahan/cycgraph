/**
 * give_up — flag the picked issue when no pull request can be delivered.
 *
 * One node serves every dead end in the graph — a finding already gone, a
 * spent gate budget, an unapproved review — so the comment names which one
 * sent the run here and carries that path's evidence. A detached run has no
 * issue to flag. The label makes the picker skip the issue until a human
 * intervenes.
 *
 * @module maintenance/issue-fix/tools/give-up
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { flagNeedsHuman } from '../../shared/repo.js';
import type { IssueFixContext } from '../context.js';

/** The give-up tool, bound to the run's context. */
export function giveUpTool(c: IssueFixContext) {
  const { repoRoot, token, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'give_up',
    description: 'Flag the picked issue as waiting on a human when the run cannot deliver a pull request.',
    parameters: z.object({
      pick_result: z.unknown().optional(),
      baseline_result: z.unknown().optional(),
      judge_result: z.object({ attempts: z.number() }).partial().optional(),
      checks_result: z.unknown().optional(),
      review_check_result: z.unknown().optional(),
    }),
    timeoutMs: 60_000,
    execute: async ({ pick_result, baseline_result, judge_result, checks_result, review_check_result }) => {
      const issue = (pick_result as { issue_number?: number } | undefined)?.issue_number;
      if (issue === undefined) return { flagged: false, detail: 'detached run — nothing to flag' };
      const baseline = baseline_result as { has_target?: boolean; detail?: string } | undefined;
      const review = review_check_result as { approved?: boolean; round?: number; detail?: string } | undefined;
      // The order mirrors the edge conditions: no target, then the spent
      // gate budget, then the unapproved review.
      const [cause, evidence] = baseline?.has_target === false
        ? ['the finding it names is no longer in the tree, so there is nothing to fix', String(baseline.detail ?? '')]
        : (judge_result?.attempts ?? 0) >= 3
          ? ['three consecutive gate failures without green checks', String((checks_result as { output?: unknown } | undefined)?.output ?? '')]
          : [`the reviewer never approved after ${String(review?.round ?? 0)} round(s)`, String(review?.detail ?? '')];
      const result = await flagNeedsHuman(repoRoot, issue, [
        `issue-fix ended without a pull request — ${cause} — so this issue now carries the \`${ctx.labels.needsHuman}\` label and the picker skips it.`,
        'Remove the label to re-queue it, close the issue if it is already settled, or investigate the evidence below.',
        '',
        '```',
        evidence.slice(-1_500),
        '```',
      ].join('\n'), { label: ctx.labels.needsHuman, ...auth });
      return {
        flagged: result.flagged,
        issue_number: issue,
        detail: result.flagged ? `flagged #${issue}; ${result.detail}` : result.detail,
      };
    },
  });
}
