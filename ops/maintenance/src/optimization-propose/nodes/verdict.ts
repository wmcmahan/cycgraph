/**
 * verdict — compare the two benchmark runs and scope-check the diff.
 *
 * @module maintenance/optimization-propose/nodes/verdict
 */

import { node } from '@cycgraph/orchestrator';
import type { OptProposeTools } from '../tools/index.js';
import type { benchBeforeNode } from './bench-before.js';
import type { benchAfterNode } from './bench-after.js';

/** The bench_verdict tool node, reading both benchmark runs. */
export function verdictNode(
  tools: OptProposeTools,
  benchBefore: ReturnType<typeof benchBeforeNode>,
  benchAfter: ReturnType<typeof benchAfterNode>,
) {
  return node({
    id: 'verdict',
    type: 'tool',
    toolId: 'bench_verdict',
    tools: [tools.verdict],
    reads: [benchBefore.result, benchAfter.result],
  });
}
