/**
 * file_tickets — file the shortlisted findings as marker-keyed issues.
 *
 * @module maintenance/repo-audit/tools/ticket
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { createIssue, findingMarker } from '@cycgraph/tools/git';
import { auditKey, renderAuditIssueBody, type AuditFinding } from '../findings.js';
import type { RepoAuditContext } from '../context.js';

/** The ticket-filing tool, bound to the run's context. */
export function ticketTool(c: RepoAuditContext) {
  const { repoRoot, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'file_tickets',
    description: 'File the shortlisted findings as marker-keyed, deduped issues.',
    parameters: z.object({ sift_result: z.unknown().optional() }),
    timeoutMs: 300_000,
    execute: async ({ sift_result }) => {
      const kept = ((sift_result as { kept?: AuditFinding[] } | undefined)?.kept) ?? [];
      if (!p.file) return { filed: 0, detail: 'dry run' };

      const urls: string[] = [];
      const failures: string[] = [];
      for (const finding of kept) {
        const outcome = await createIssue(repoRoot, {
          title: finding.title,
          body: renderAuditIssueBody(finding, findingMarker(auditKey(finding.title), ctx.markerNamespace)),
          labels: ['audit', `severity:${finding.severity}`, ...(p.approve ? [ctx.labels.approved] : [])],
        }, auth);
        if ('url' in outcome) urls.push(outcome.url);
        else failures.push(outcome.error);
      }
      return {
        filed: urls.length,
        urls,
        ...(failures.length > 0 ? { failures } : {}),
        detail: `filed ${urls.length} of ${kept.length}`,
      };
    },
  });
}
