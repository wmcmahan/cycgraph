/**
 * verdict — decide whether the re-applied change still measures a win.
 *
 * @module maintenance/optimization-apply/nodes/verdict
 */

import { node } from '@cycgraph/orchestrator';
import type { OptApplyTools } from '../tools/index.js';
import type { pickNode } from './pick.js';
import type { benchBeforeNode } from './bench-before.js';
import type { benchAfterNode } from './bench-after.js';

/** The bench_verdict tool node, reading the ticket and both benchmark runs. */
export function verdictNode(
  tools: OptApplyTools,
  pick: ReturnType<typeof pickNode>,
  benchBefore: ReturnType<typeof benchBeforeNode>,
  benchAfter: ReturnType<typeof benchAfterNode>,
) {
  return node({
    id: 'verdict',
    type: 'tool',
    toolId: 'bench_verdict',
    tools: [tools.verdict],
    reads: [pick.result, benchBefore.result, benchAfter.result],
  });
}
