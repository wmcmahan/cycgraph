/**
 * implement — the implementer at work.
 *
 * The agent node. It reads the picked ticket plus the last acceptance
 * result, its own prior report, and any reviewer findings (so a retry
 * starts oriented) and writes its report. Draws the maintenance lesson pool
 * when memory is on.
 *
 * @module maintenance/implement-ticket/nodes/implement
 */

import { node } from '@cycgraph/orchestrator';
import { MAINT_TAG } from '../../shared/memory.js';
import type { ImplementContext } from '../context.js';
import type { implementerAgent } from '../agents/implementer.js';
import type { pickNode } from './pick.js';

/** The implementer agent node, reading the ticket and prior-attempt feedback. */
export function implementNode(
  c: ImplementContext,
  implementer: ReturnType<typeof implementerAgent>,
  pick: ReturnType<typeof pickNode>,
) {
  return node({
    id: 'implement',
    agent: implementer,
    failurePolicy: { timeoutMs: 1_800_000 },
    // Reading its own previous report carries knowledge across attempts: a
    // retry starts from the prior NOTES instead of re-reading into a fresh
    // transcript.
    reads: [pick.result, 'accept_result', 'implement_report', 'review'],
    writes: 'implement_report',
    // The whole lesson pool, not a per-workflow tag: defect-class lessons
    // distilled from reviews apply to every editing agent.
    ...(c.env.memory ? { memoryQuery: { tags: [MAINT_TAG], maxFacts: 6 } } : {}),
  });
}
