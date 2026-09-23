/**
 * fix — the fixer at work: correct the targeted claim.
 *
 * Reads the scan result, the last judge verdict, and its own prior report
 * (so a retry starts from the prior NOTES) and writes its report. Draws the
 * scenario's eval-gated lesson pool when memory is on.
 *
 * @module maintenance/docs/nodes/fix
 */

import { node } from '@cycgraph/orchestrator';
import type { DocsContext } from '../context.js';
import type { fixerAgent } from '../agents/fixer.js';
import type { scanNode } from './scan.js';

/** The fixer agent node, reading the scan result and prior-attempt feedback. */
export function fixNode(
  c: DocsContext,
  fixer: ReturnType<typeof fixerAgent>,
  scan: ReturnType<typeof scanNode>,
) {
  return node({
    id: 'fix',
    agent: fixer,
    failurePolicy: { timeoutMs: 600_000 },
    reads: [scan.result, 'judge_result', 'fix_report'],
    writes: 'fix_report',
    // Lessons distilled by earlier runs' reflection, eval-gated.
    ...(c.env.memory ? { memoryQuery: { tags: [`wf:${c.id}`], maxFacts: 8 } } : {}),
  });
}
