/**
 * review_check — parse the reviewer's verdict.
 *
 * A tool node running review_check, reading the review and prior check
 * result (to increment the round the review loop is bounded by).
 *
 * @module maintenance/issue-fix/nodes/review-check
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';

/** The review_check tool node. */
export function reviewCheckNode(tools: IssueFixTools) {
  return node({ id: 'review_check', type: 'tool', toolId: 'review_check', tools: [tools.reviewCheck], reads: ['review', 'review_check_result'] });
}
