/**
 * giveup — the graph's single dead-end handler.
 *
 * A tool node running give_up. Every dead end routes here — a finding gone,
 * a spent gate budget, an unapproved review — so it reads all the evidence
 * paths and flags the picked issue needs-human.
 *
 * @module maintenance/issue-fix/nodes/give-up
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';
import type { pickNode } from './pick.js';
import type { baselineNode } from './baseline.js';

/** The give_up tool node, reading every dead-end path's evidence. */
export function giveUpNode(
  tools: IssueFixTools,
  pick: ReturnType<typeof pickNode>,
  baseline: ReturnType<typeof baselineNode>,
) {
  return node({
    id: 'giveup',
    type: 'tool',
    toolId: 'give_up',
    tools: [tools.giveUp],
    reads: [pick.result, baseline.result, 'judge_result', 'checks_result', 'review_check_result'],
  });
}
