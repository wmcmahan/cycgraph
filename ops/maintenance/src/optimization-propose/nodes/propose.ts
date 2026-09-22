/**
 * propose — the optimizer at work.
 *
 * The agent node. It reads the baseline table and the last verdict (so a
 * retry picks a different bottleneck) and writes its proposal.
 *
 * @module maintenance/optimization-propose/nodes/propose
 */

import { node } from '@cycgraph/orchestrator';
import type { optimizerAgent } from '../agents/optimizer.js';
import type { benchBeforeNode } from './bench-before.js';

/** The optimizer agent node, reading the baseline and prior verdict. */
export function proposeNode(
  optimizer: ReturnType<typeof optimizerAgent>,
  benchBefore: ReturnType<typeof benchBeforeNode>,
) {
  return node({
    id: 'propose',
    agent: optimizer,
    failurePolicy: { timeoutMs: 1_200_000 },
    reads: [benchBefore.result, 'verdict_result'],
    writes: 'proposal',
  });
}
