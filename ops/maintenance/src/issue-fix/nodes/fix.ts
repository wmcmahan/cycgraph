/**
 * fix — the fixer at work.
 *
 * The agent node. It reads the baseline brief plus the last judge result,
 * checks result, and reviewer findings (so a gate- or review-retry learns
 * what failed) and writes its report. Draws the maintenance lesson pool
 * when memory is on.
 *
 * @module maintenance/issue-fix/nodes/fix
 */

import { node } from '@cycgraph/orchestrator';
import { MAINT_TAG } from '../../shared/memory.js';
import type { IssueFixContext } from '../context.js';
import type { fixerAgent } from '../agents/fixer.js';
import type { baselineNode } from './baseline.js';

/** The fixer agent node, reading the baseline brief and prior-attempt feedback. */
export function fixNode(
  c: IssueFixContext,
  fixer: ReturnType<typeof fixerAgent>,
  baseline: ReturnType<typeof baselineNode>,
) {
  return node({
    id: 'fix',
    agent: fixer,
    failurePolicy: { timeoutMs: 1_200_000 },
    // checks_result rides the gate-retry: without it the fixer never learns
    // which tests its last attempt broke.
    reads: [baseline.result, 'judge_result', 'checks_result', 'review'],
    writes: 'fix_report',
    // The whole lesson pool, not a per-workflow tag: defect-class lessons
    // distilled from reviews apply to every editing agent.
    ...(c.env.memory ? { memoryQuery: { tags: [MAINT_TAG], maxFacts: 6 } } : {}),
  });
}
