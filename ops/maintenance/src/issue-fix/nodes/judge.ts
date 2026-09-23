/**
 * judge — decide whether the fix resolved its finding.
 *
 * A tool node running judge_fix, reading the picked issue, the baseline,
 * the prior judge result, and the last gate verdict (to count attempts).
 *
 * @module maintenance/issue-fix/nodes/judge
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';
import type { pickNode } from './pick.js';
import type { baselineNode } from './baseline.js';

/** The judge_fix tool node. */
export function judgeNode(
  tools: IssueFixTools,
  pick: ReturnType<typeof pickNode>,
  baseline: ReturnType<typeof baselineNode>,
) {
  return node({
    id: 'judge',
    type: 'tool',
    toolId: 'judge_fix',
    tools: [tools.judgeFix],
    reads: [pick.result, baseline.result, 'judge_result', 'gate_verification_passed'],
  });
}
