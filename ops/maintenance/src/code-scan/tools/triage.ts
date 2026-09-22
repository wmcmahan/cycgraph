/**
 * triage_findings — dedupe findings against open issues and file the new
 * ones, capped.
 *
 * The proposal ledger externalized: each finding becomes one issue carrying
 * a stable marker, deduped against open issues so nothing is filed twice,
 * and capped per run. Filing is refused entirely when the ledger cannot be
 * read, because filing blind is how duplicates happen.
 *
 * @module maintenance/code-scan/tools/triage
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { unfiledFindings, type CoreFinding } from '../scan.js';
import type { CodeScanContext } from '../context.js';

/** The issue payload for one finding: title, labels, marker-carrying body. */
function issueFor(finding: CoreFinding, labels: string[], namespace: string): { title: string; body: string; labels: string[] } {
  return {
    title: `[maintenance] ${finding.kind} in ${finding.file}`,
    labels,
    body: [
      finding.detail,
      '',
      `Location: \`${finding.file}:${finding.line}\``,
      '',
      'Filed by the code-scan workflow from a mechanical scan of the repository.',
      '',
      findingMarker(finding.key, namespace),
    ].join('\n'),
  };
}

/** The dedupe-and-file tool, bound to the run's context. */
export function triageTool(c: CodeScanContext) {
  const { repoRoot, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'triage_findings',
    description: 'Dedupe findings against open issues and file the new ones, capped.',
    parameters: z.object({ scan_result: z.unknown().optional() }),
    timeoutMs: 120_000,
    execute: async ({ scan_result }) => {
      const scan = scan_result as { findings?: CoreFinding[] } | undefined;
      const findings = scan?.findings ?? [];
      const issues = await listOpenIssues(repoRoot, auth);

      if (issues === undefined) {
        return {
          ledger_visible: false,
          filed: [],
          detail: p.file
            ? 'cannot read the issue ledger (gh missing, unauthenticated, or no remote) — refusing to file blind'
            : 'cannot read the issue ledger — candidates below are not deduped',
          ...(p.file ? {} : { would_file: findings.slice(0, p.maxIssues).map((f) => f.key) }),
        };
      }

      const fresh = unfiledFindings(findings, issueMarkers(issues, ctx.markerNamespace));
      const toFile = fresh.slice(0, p.maxIssues);
      const base = {
        ledger_visible: true,
        new_count: fresh.length,
        skipped_existing: findings.length - fresh.length,
      };
      if (!p.file) {
        return { ...base, filed: [], would_file: toFile.map((f) => f.key), detail: 'dry run' };
      }

      const filed: { key: string; url: string }[] = [];
      const errors: string[] = [];
      for (const finding of toFile) {
        const outcome = await createIssue(
          repoRoot,
          issueFor(finding, p.approve ? [ctx.labels.approved] : [], ctx.markerNamespace),
          auth);
        if ('url' in outcome) filed.push({ key: finding.key, url: outcome.url });
        else errors.push(`${finding.key}: ${outcome.error}`);
      }
      return {
        ...base,
        filed,
        errors,
        detail: `filed ${filed.length} of ${toFile.length} new finding(s); ${fresh.length - filed.length} remain`,
      };
    },
  });
}
