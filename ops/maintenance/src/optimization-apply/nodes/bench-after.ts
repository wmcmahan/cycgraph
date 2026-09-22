/**
 * bench_after — re-measure after the diff, the same way.
 *
 * @module maintenance/optimization-apply/nodes/bench-after
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';

/** The bench_after tool node. */
export function benchAfterNode(tools: OptApplyTools) {
  return node({
    id: 'bench_after',
    type: 'tool',
    toolId: 'bench_after',
    tools: [tools.benchAfter],
    reads: []
  });
}
