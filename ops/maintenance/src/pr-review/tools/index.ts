/**
 * The reviewer's read-only hands and the run's three tool-node primitives.
 *
 * `hands` are the search/read tools the reviewer drives directly; the tool
 * nodes bracket it — `gather` checks out the PR and assembles the brief,
 * `verdict` parses the reply, and `deliver` submits the review. Each is its
 * own file; this barrel binds them all to one {@link ReviewContext}.
 *
 * @module maintenance/pr-review/tools
 */

import type { ReviewContext } from '../context.js';
import { reviewHands } from './hands.js';
import { gatherPrTool } from './gather-pr.js';
import { reviewVerdictTool } from './review-verdict.js';
import { postReviewTool } from './post-review.js';

/** Build every tool the run needs, bound to the given context. */
export function reviewTools(c: ReviewContext) {
  return {
    hands: reviewHands(c),
    gather: gatherPrTool(c),
    verdict: reviewVerdictTool(),
    deliver: postReviewTool(c),
  };
}

/** The reviewer's hands and the run's tool-node primitives. */
export type ReviewTools = ReturnType<typeof reviewTools>;
