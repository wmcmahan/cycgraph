/**
 * sift_findings — parse, evidence-check, dedupe, and rank the reports.
 *
 * The mechanical judge over the fan-out: evidence must name real paths,
 * duplicates and already-filed findings drop, severity ranks the rest, and
 * the shortlist is capped. Distinguishes an unreadable ledger (an
 * environmental failure, not an audit-quality one) so the caller does not
 * record it as outcome evidence against the run's injected lessons.
 *
 * @module maintenance/repo-audit/tools/sift
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { siftAuditFindings } from '../findings.js';
import type { RepoAuditContext } from '../context.js';

/** The report-sifting tool, bound to the run's context. */
export function siftTool(c: RepoAuditContext) {
  const { repoRoot, workspaceAt, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'sift_findings',
    description: 'Parse, evidence-check, dedupe, and rank the auditors\' findings.',
    parameters: z.object({
      audit_results: z.unknown().optional(),
      audit_error_count: z.unknown().optional(),
    }),
    timeoutMs: 120_000,
    execute: async ({ audit_results, audit_error_count }) => {
      const entries = (Array.isArray(audit_results) ? audit_results : []) as
        Array<{ updates?: Record<string, unknown> }>;
      const reports = entries
        .map((entry) => entry.updates?.['audit_report'])
        .filter((report): report is string => typeof report === 'string' && report.trim() !== '');

      const issues = await listOpenIssues(repoRoot, auth);
      const sifted = siftAuditFindings(reports, {
        pathExists: (path) => existsSync(join(workspaceAt, path)),
        ...(issues !== undefined ? { openKeys: issueMarkers(issues, ctx.markerNamespace) } : {}),
        cap: p.maxFindings,
      });

      const errorCount = typeof audit_error_count === 'number' ? audit_error_count : 0;
      const ledgerUnavailable = issues === undefined && p.file;
      return {
        // Coherent means the fan-out produced something to judge: at least
        // one auditor reported, and the issue ledger was readable when
        // filing is on (filing blind would duplicate tickets).
        ok: reports.length > 0 && !ledgerUnavailable,
        // An unreadable ledger is an ENVIRONMENTAL failure, not an
        // audit-quality one — the caller must not record it as outcome
        // evidence against the lessons injected into this run.
        ...(ledgerUnavailable ? { ledger_unavailable: true } : {}),
        report_count: reports.length,
        worker_errors: errorCount,
        kept: sifted.kept,
        kept_count: sifted.kept.length,
        drops: sifted.drops,
        clean_reports: sifted.clean_reports,
      };
    },
  });
}
