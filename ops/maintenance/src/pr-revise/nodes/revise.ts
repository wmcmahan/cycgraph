/**
 * revise — the reviser at work.
 *
 * The agent node. It reads the gathered feedback and the last checks
 * result (so a retry sees why the previous attempt failed) and writes its
 * report. When lessons are on it draws the whole maintenance pool, not a
 * per-workflow tag: defect-class lessons distilled from reviews apply to
 * every editing agent.
 *
 * @module maintenance/pr-revise/nodes/revise
 */

import { node } from '@cycgraph/orchestrator';
import { MAINT_TAG } from '../../shared/memory.js';
import type { ReviseContext } from '../context.js';
import type { reviserAgent } from '../agents/reviser.js';
import type { gatherNode } from './gather.js';

/** The reviser agent node, reading gather's result and looping on the gate. */
export function reviseNode(
  c: ReviseContext,
  reviser: ReturnType<typeof reviserAgent>,
  gather: ReturnType<typeof gatherNode>,
) {
  return node({
    id: 'revise',
    agent: reviser,
    failurePolicy: { timeoutMs: 1_200_000 },
    reads: [gather.result, 'checks_result'],
    writes: 'revise_report',
    ...(c.env.memory ? { memoryQuery: { tags: [MAINT_TAG], maxFacts: 6 } } : {}),
  });
}
