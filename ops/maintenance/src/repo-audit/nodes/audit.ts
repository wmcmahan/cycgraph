/**
 * audit — the fan-out over charters.
 *
 * A map node that runs the `audit_worker` agent once per charter, capped
 * and concurrency-limited, best-effort so one auditor's failure does not
 * sink the run.
 *
 * @module maintenance/repo-audit/nodes/audit
 */

import { mapReduce } from '@cycgraph/orchestrator';
import type { RepoAuditContext } from '../context.js';
import type { cloneNode } from './clone.js';

/** The map node fanning `audit_worker` over the clone's charter list. */
export function auditNode(c: RepoAuditContext, clone: ReturnType<typeof cloneNode>) {
  return mapReduce('audit_worker', {
    id: 'audit',
    items: `$.memory.${clone.result}.charters`,
    concurrency: c.params.concurrency,
    maxItems: 32,
    onError: 'best_effort',
    taskTimeoutMs: 1_200_000,
    reads: [clone.result],
  });
}
