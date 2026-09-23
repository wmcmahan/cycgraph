/**
 * review_verdict — parse the reviewer's reply into a verdict.
 *
 * Reads the VERDICT marker and counts findings, incrementing the round so
 * the graph can bound retries. No marker at all is a reviewer that ran out
 * of steps mid-investigation, not a request for changes: it reports
 * `malformed`, which routes to the diff-only fallback rather than to a
 * REVISE handoff.
 *
 * @module maintenance/pr-review/tools/review-verdict
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { parseReviewVerdict } from '../../shared/review-findings.js';

/** The verdict-parsing tool. Pure: no repository access. */
export function reviewVerdictTool() {
  return tool({
    name: 'review_verdict',
    description: 'Parse the review into a verdict and finding count.',
    parameters: z.object({ review: z.unknown().optional(), verdict_result: z.unknown().optional() }),
    execute: async ({ review, verdict_result }) => {
      const text = String(review ?? '');
      const round = ((verdict_result as { round?: number } | undefined)?.round ?? 0) + 1;
      // No marker at all is a reviewer that ran out of steps
      // mid-investigation, not a request for changes: inconclusive,
      // retried once, and never handed to pr-revise.
      const parsed = parseReviewVerdict(text);
      const malformed = parsed === undefined;
      const approved = parsed === 'APPROVE';
      const findings = (text.match(/^\s*\d+\.\s/gm) ?? []).length;
      return {
        approved,
        malformed,
        round,
        finding_count: findings,
        detail: malformed
          ? `the review carries no VERDICT marker (round ${round}) — inconclusive`
          : approved
            ? `approved with ${findings} advisory note(s)`
            : `requested changes: ${findings} finding(s)`,
      };
    },
  });
}
