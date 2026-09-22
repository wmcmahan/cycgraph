/**
 * sift — parse, evidence-check, dedupe, and rank the fan-out's reports.
 *
 * @module maintenance/repo-audit/nodes/sift
 */

import { node } from '@cycgraph/orchestrator';
import type { RepoAuditTools } from '../tools/index.js';
import type { auditNode } from './audit.js';

/** The sift_findings tool node, reading the map's results and error count. */
export function siftNode(tools: RepoAuditTools, audit: ReturnType<typeof auditNode>) {
  return node({
    id: 'sift',
    type: 'tool',
    toolId: 'sift_findings',
    tools: [tools.sift],
    reads: [audit.results, audit.errorCount],
  });
}
