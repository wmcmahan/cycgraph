/**
 * file_ticket — file the verified proposal as a marker-keyed, deduped issue.
 *
 * What a passing run produces is a ticket, not a PR: the issue carries the
 * proposal, the measured detail, and the verified diff, and waits for a
 * human to approve. Filing follows the ledger rules — refused when the
 * ledger cannot be read, and skipped when an open ticket already carries
 * this proposal (by current or pre-digest key).
 *
 * @module maintenance/optimization-propose/tools/ticket
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { createIssue, findingMarker, issueMarkers, listOpenIssues, pendingDiff } from '@cycgraph/tools/git';
import { keySlug, legacyKeySlug } from '../../shared/key-slug.js';
import type { BenchComparison } from '../../tune/bench.js';
import type { OptProposeContext } from '../context.js';

/** The dedupe key for a proposal: its top improved benchmark and changed files. */
function keyFor(comparison: BenchComparison, files: readonly string[]): string {
  const top = [...comparison.improved].sort((a, b) => b.pct - a.pct)[0];
  return `optimization:${keySlug(top?.id ?? 'none')}:${keySlug(files.join('+'))}`;
}

/** The pre-digest key an already-filed ticket for this proposal may carry. */
function legacyKeyFor(comparison: BenchComparison, files: readonly string[]): string {
  const top = [...comparison.improved].sort((a, b) => b.pct - a.pct)[0];
  const truncate = (text: string) => legacyKeySlug(text).slice(0, 60);
  return `optimization:${truncate(top?.id ?? 'none')}:${truncate(files.join('+'))}`;
}

/** The ticket-filing tool, bound to the run's context. */
export function ticketTool(c: OptProposeContext) {
  const { repoRoot, workspaceAt, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'file_ticket',
    description: 'File the verified proposal as a marker-keyed, deduped issue.',
    parameters: z.object({
      verdict_result: z.unknown().optional(),
      proposal: z.unknown().optional(),
    }),
    timeoutMs: 120_000,
    execute: async ({ verdict_result, proposal }) => {
      const verdict = verdict_result as (BenchComparison & { changed_files?: string[]; detail?: string }) | undefined;
      const files = verdict?.changed_files ?? [];
      const comparison = verdict ?? { improved: [], regressed: [], unchanged: 0, disappeared: [] };
      const key = keyFor(comparison, files);
      const diff = await pendingDiff(workspaceAt);
      if (!p.file) return { filed: false, key, detail: 'dry run', diff };

      const issues = await listOpenIssues(repoRoot, auth);
      if (issues === undefined) {
        return { filed: false, key, diff, detail: 'cannot read the issue ledger — refusing to file blind' };
      }
      const markers = issueMarkers(issues, ctx.markerNamespace);
      if (markers.has(key) || markers.has(legacyKeyFor(comparison, files))) {
        return { filed: false, key, detail: 'an open ticket already carries this proposal' };
      }

      const top = [...(verdict?.improved ?? [])].sort((a, b) => b.pct - a.pct)[0];
      const outcome = await createIssue(repoRoot, {
        title: `[optimization] ${top !== undefined ? `${top.id} +${top.pct.toFixed(1)}%` : 'measured proposal'}`,
        body: [
          String(proposal ?? '(no description)'),
          '',
          `Measured: ${verdict?.detail ?? ''}`,
          '',
          'Verified diff (re-verified and applied by the optimization-apply workflow on approval):',
          '```diff',
          diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (truncated)` : diff,
          '```',
          '',
          `Proposed by the optimization-propose workflow. Approve with the \`${ctx.labels.approved}\` label.`,
          '',
          findingMarker(key, ctx.markerNamespace),
        ].join('\n'),
      }, auth);
      return 'url' in outcome
        ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
        : { filed: false, key, diff, detail: `could not file: ${outcome.error}` };
    },
  });
}
