/**
 * reflect — the cross-run learning tail.
 *
 * A reflection node that distills the run's fixer notes and judge verdicts
 * into candidate lessons via the distiller. Present only when memory is
 * wired — a reflection node with no writer fails the run at execution.
 *
 * @module maintenance/docs/nodes/reflect
 */

import { reflection } from '@cycgraph/orchestrator';
import { CANDIDATE_TAG, LESSON_TAG, MAINT_TAG } from '../../shared/memory.js';
import type { DocsContext } from '../context.js';
import type { distillerAgent } from '../agents/distiller.js';

/** The reflection node, or `undefined` when memory is off. */
export function reflectNode(c: DocsContext, distiller: ReturnType<typeof distillerAgent>) {
  if (!c.env.memory) return undefined;
  return reflection(['fix_report', 'judge_result'], {
    id: 'reflect',
    reads: ['fix_report', 'judge_result'],
    failurePolicy: { maxRetries: 2 },
    extractor: { type: 'llm', agentId: distiller, maxFacts: 4 },
    tags: [LESSON_TAG, MAINT_TAG, `wf:${c.id}`, CANDIDATE_TAG],
  });
}
