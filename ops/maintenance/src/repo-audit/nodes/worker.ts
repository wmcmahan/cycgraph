/**
 * audit_worker — one auditor, the map body.
 *
 * The agent node the `audit` map node fans out. It reads the clone result
 * (its charter arrives via the map's task context) and writes its report.
 * Draws the eval-gated audit lesson pool when memory is on.
 *
 * @module maintenance/repo-audit/nodes/worker
 */

import { node } from '@cycgraph/orchestrator';
import type { RepoAuditContext } from '../context.js';
import type { auditorAgent } from '../agents/auditor.js';
import type { cloneNode } from './clone.js';

/** The auditor agent node fanned out by the map. */
export function workerNode(
  c: RepoAuditContext,
  auditor: ReturnType<typeof auditorAgent>,
  clone: ReturnType<typeof cloneNode>,
) {
  return node({
    id: 'audit_worker',
    agent: auditor,
    failurePolicy: { timeoutMs: 1_200_000 },
    reads: [clone.result],
    writes: 'audit_report',
    // Lessons from earlier audits, eval-gated: what got dropped for missing
    // evidence, which charters keep coming back clean.
    ...(c.env.memory ? { memoryQuery: { tags: ['wf:repo-audit'], maxFacts: 8 } } : {}),
  });
}
