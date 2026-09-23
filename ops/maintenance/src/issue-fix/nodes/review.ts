/**
 * review — the advisory reviewer at work.
 *
 * The agent node. It reads the baseline brief, the fix diff, and the
 * fixer's report, and writes the review the round-counter then parses.
 *
 * @module maintenance/issue-fix/nodes/review
 */

import { node } from '@cycgraph/orchestrator';
import type { reviewerAgent } from '../agents/reviewer.js';
import type { baselineNode } from './baseline.js';
import type { diffNode } from './diff.js';

/** The advisory reviewer node, reading the baseline, the diff, and the report. */
export function reviewNode(
  reviewer: ReturnType<typeof reviewerAgent>,
  baseline: ReturnType<typeof baselineNode>,
  diff: ReturnType<typeof diffNode>,
) {
  return node({
    id: 'review',
    agent: reviewer,
    failurePolicy: { timeoutMs: 300_000 },
    reads: [baseline.result, diff.result, 'fix_report'],
    writes: 'review',
  });
}
