/**
 * bench_before — measure the baseline before the optimizer edits.
 *
 * @module maintenance/optimization-propose/nodes/bench-before
 */

import { node } from '@cycgraph/orchestrator';
import type { OptProposeTools } from '../tools/index.js';

/** The bench_before tool node. */
export function benchBeforeNode(tools: OptProposeTools) {
  return node({
    id: 'bench_before',
    type: 'tool',
    toolId: 'bench_before',
    tools: [tools.benchBefore],
    reads: []
  });
}
