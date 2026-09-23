/**
 * file_ticket — file the well-formed proposal as a marker-keyed, deduped issue.
 *
 * Refused when the ledger cannot be read, and skipped when an open ticket
 * already carries this proposal (by current or pre-digest key).
 *
 * @module maintenance/feature-propose/tools/ticket
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { legacyProposalKey, proposalKey } from '../../shared/proposal.js';
import type { FeatProposeContext } from '../context.js';

/** The ticket-filing tool, bound to the run's context. */
export function ticketTool(c: FeatProposeContext) {
  const { repoRoot, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'file_ticket',
    description: 'File the well-formed proposal as a marker-keyed, deduped issue.',
    parameters: z.object({
      shape_result: z.unknown().optional(),
      proposal: z.unknown().optional(),
    }),
    timeoutMs: 120_000,
    execute: async ({ shape_result, proposal }) => {
      const shape = shape_result as { title?: string } | undefined;
      const key = proposalKey(shape?.title ?? '');
      if (!p.file) return { filed: false, key, detail: 'dry run' };

      const issues = await listOpenIssues(repoRoot, auth);
      if (issues === undefined) {
        return { filed: false, key, detail: 'cannot read the issue ledger — refusing to file blind' };
      }
      const markers = issueMarkers(issues, ctx.markerNamespace);
      if (markers.has(key) || markers.has(legacyProposalKey(shape?.title ?? ''))) {
        return { filed: false, key, detail: 'an open ticket already carries this proposal' };
      }

      const outcome = await createIssue(repoRoot, {
        title: `[feature] ${shape?.title ?? 'proposal'}`,
        body: [
          String(proposal ?? ''),
          '',
          'Proposed by the feature-propose workflow from a read-only study of the codebase.',
          `Approve with the \`${ctx.labels.approved}\` label; implementation and the PR follow the maintenance ladder, and the merge is the accept signal.`,
          '',
          findingMarker(key, ctx.markerNamespace),
        ].join('\n'),
      }, auth);
      return 'url' in outcome
        ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
        : { filed: false, key, detail: `could not file: ${outcome.error}` };
    },
  });
}
