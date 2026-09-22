/**
 * judge — re-scan and decide whether the targeted claim is corrected.
 *
 * @module maintenance/docs/nodes/judge
 */

import { node } from '@cycgraph/orchestrator';
import type { DocsTools } from '../tools/index.js';
import type { scanNode } from './scan.js';

/** The judge_fix tool node, reading the scan result and prior judge verdict. */
export function judgeNode(tools: DocsTools, scan: ReturnType<typeof scanNode>) {
  return node({ id: 'judge', type: 'tool', toolId: 'judge_fix', tools: [tools.judge], reads: [scan.result, 'judge_result'] });
}
