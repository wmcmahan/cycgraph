/**
 * baseline — re-locate the finding and brief the fixer.
 *
 * A tool node running baseline_scan, reading the picked issue.
 *
 * @module maintenance/issue-fix/nodes/baseline
 */

import { node } from '@cycgraph/orchestrator';
import type { IssueFixTools } from '../tools/index.js';
import type { pickNode } from './pick.js';

/** The baseline_scan tool node, reading pick's result. */
export function baselineNode(tools: IssueFixTools, pick: ReturnType<typeof pickNode>) {
  return node({
    id: 'baseline',
    type: 'tool',
    toolId: 'baseline_scan',
    tools: [tools.baseline],
    reads: [pick.result]
  });
}
