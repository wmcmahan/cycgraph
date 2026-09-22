/**
 * review_check — parse the reviewer's verdict and count rounds.
 *
 * Reads the reviewer's reply for an APPROVED marker and increments the
 * round so the graph can bound the review loop. Pure: no repository access.
 *
 * @module maintenance/issue-fix/tools/review-check
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';

/** The reviewer-verdict-parsing tool. */
export function reviewCheckTool() {
  return tool({
    name: 'review_check',
    description: 'Parse the reviewer\'s verdict and count review rounds.',
    parameters: z.object({
      review: z.unknown().optional(),
      review_check_result: z.unknown().optional(),
    }),
    execute: async ({ review, review_check_result }) => {
      const text = String(review ?? '');
      const round = ((review_check_result as { round?: number } | undefined)?.round ?? 0) + 1;
      const approved = /^\s*APPROVED/m.test(text);
      return {
        approved,
        round,
        detail: approved
          ? `review approved (round ${round})`
          : `review requested revisions (round ${round}): ${text.replace(/\n/g, ' ').slice(0, 240)}`,
      };
    },
  });
}
