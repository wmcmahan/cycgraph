/**
 * bench_before — measure the baseline before re-applying the diff.
 *
 * @module maintenance/optimization-apply/nodes/bench-before
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';

/** The bench_before tool node. */
export function benchBeforeNode(tools: OptApplyTools) {
  return node({
    id: 'bench_before',
    type: 'tool',
    toolId: 'bench_before',
    tools: [tools.benchBefore],
    reads: []
  });
}
