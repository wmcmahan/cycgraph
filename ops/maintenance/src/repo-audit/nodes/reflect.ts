/**
 * reflect — the cross-run learning tail.
 *
 * A reflection node that distills the sift accounting into candidate
 * lessons via the distiller agent. Present only when memory is wired; it
 * sits between sift and gate so clean audits teach too. Without memory the
 * node is absent and the graph runs sift → gate.
 *
 * @module maintenance/repo-audit/nodes/reflect
 */

import { reflection } from '@cycgraph/orchestrator';
import { CANDIDATE_TAG, LESSON_TAG, MAINT_TAG } from '../../shared/memory.js';
import type { RepoAuditContext } from '../context.js';
import type { distillerAgent } from '../agents/distiller.js';
import type { siftNode } from './sift.js';

/** The reflection node, or `undefined` when memory is off. */
export function reflectNode(
  c: RepoAuditContext,
  distiller: ReturnType<typeof distillerAgent>,
  sift: ReturnType<typeof siftNode>,
) {
  if (!c.env.memory) return undefined;
  return reflection([sift.result], {
    id: 'reflect',
    reads: [sift.result],
    failurePolicy: { maxRetries: 2 },
    extractor: { type: 'llm', agentId: distiller, maxFacts: 3 },
    tags: [LESSON_TAG, MAINT_TAG, 'wf:repo-audit', CANDIDATE_TAG],
  });
}
