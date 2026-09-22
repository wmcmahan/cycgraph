/**
 * file_ticket — file the winning proposal as a marker-keyed, deduped ticket.
 *
 * The ticket carries the hypothesis, the measured trial table, and the
 * exact diff; a human approves it with the maintenance-approved label and
 * implement-ticket applies it. Refused when the ledger cannot be read, and
 * skipped when an open ticket already carries this proposal.
 *
 * @module maintenance/tune/tools/ticket
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { renderTuneTicket, tuneKey } from '../proposal.js';
import type { TuneContext } from '../context.js';

/** The ticket-filing tool, bound to the run's context. */
export function ticketTool(c: TuneContext) {
  const { repoRoot, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'file_ticket',
    description: 'File the winning proposal as a marker-keyed, deduped ticket.',
    parameters: z.object({ shape_result: z.unknown().optional(), trial_result: z.unknown().optional() }),
    timeoutMs: 120_000,
    execute: async ({ shape_result, trial_result }) => {
      const shaped = shape_result as { hypothesis?: string; file?: string; find?: string; replace?: string } | undefined;
      const trial = trial_result as { table?: string; detail?: string; cost_only?: boolean } | undefined;
      const costOnly = trial?.cost_only === true;
      if (shaped?.file === undefined) return { filed: false, detail: 'nothing to file' };
      const key = tuneKey(p.target, { file: shaped.file, replace: shaped.replace ?? '' });
      if (!p.file) return { filed: false, key, detail: 'dry run' };

      const issues = await listOpenIssues(repoRoot, auth);
      if (issues === undefined) {
        return { filed: false, key, detail: 'cannot read the issue ledger — refusing to file blind' };
      }
      if (issueMarkers(issues, ctx.markerNamespace).has(key)) {
        return { filed: false, key, detail: 'an open ticket already carries this proposal' };
      }
      const outcome = await createIssue(repoRoot, {
        title: `[tune]${costOnly ? ' cost-win' : ''} ${p.target}: ${(shaped.hypothesis ?? '').slice(0, 80)}`,
        body: renderTuneTicket({
          target: p.target,
          hypothesis: shaped.hypothesis ?? '',
          trials: p.trials,
          trialDetail: trial?.detail ?? '',
          trialTable: trial?.table ?? '',
          file: shaped.file,
          find: shaped.find ?? '',
          replace: shaped.replace ?? '',
          costOnly,
          marker: findingMarker(key, ctx.markerNamespace),
        }),
      }, auth);
      return 'url' in outcome
        ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
        : { filed: false, key, detail: `could not file: ${outcome.error}` };
    },
  });
}
