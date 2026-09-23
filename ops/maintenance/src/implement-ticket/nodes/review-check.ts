/**
 * review_check — parse the reviewer's verdict.
 *
 * @module maintenance/implement-ticket/nodes/review-check
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';

/** The review_check tool node. */
export function reviewCheckNode(tools: ImplementTools) {
  return node({ id: 'review_check', type: 'tool', toolId: 'review_check', tools: [tools.reviewCheck], reads: ['review', 'review_check_result'] });
}
