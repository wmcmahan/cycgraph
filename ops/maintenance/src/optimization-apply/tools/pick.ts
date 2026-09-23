/**
 * pick_ticket — pick the oldest approved optimization ticket and lift its
 * verified diff.
 *
 * Detached mode reads the ticket body from a file, closing nothing. The
 * ledger path records the chosen issue on the shared `picked` holder so
 * onFatal can flag it. A ticket carrying no complete diff is refused — the
 * remedy is a fresh optimization-propose run.
 *
 * @module maintenance/optimization-apply/tools/pick
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { extractTicketDiff } from '../../shared/proposal.js';
import type { OptApplyContext } from '../context.js';

/** The ticket-picking tool, bound to the run's context. */
export function pickTool(c: OptApplyContext) {
  const { repoRoot, token, params: p, maintenance: ctx, picked } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'pick_ticket',
    description: 'Pick the oldest approved optimization ticket and lift its verified diff.',
    parameters: z.object({}),
    timeoutMs: 60_000,
    execute: async () => {
      // Detached path: read the ticket body from a file, closing nothing.
      if (p.ticketFile !== '') {
        const body = await readFile(p.ticketFile, 'utf8');
        const diff = extractTicketDiff(body);
        return diff !== undefined
          ? { has_work: true, detached: true, diff }
          : { has_work: false, detail: 'the ticket file carries no complete ```diff block' };
      }

      // Ledger path: the oldest approved optimization ticket carrying a diff.
      const issues = await listOpenIssues(repoRoot, { label: p.label, ...auth });
      if (issues === undefined) {
        return { has_work: false, detail: 'cannot read the issue ledger and no --ticketFile was given' };
      }
      const candidates = issues
        .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
        .filter((issue) => [...issueMarkers([issue], ctx.markerNamespace)].some((key) => key.startsWith('optimization:')))
        .sort((a, b) => a.number - b.number);
      const chosen = candidates[0];
      if (chosen === undefined) {
        return { has_work: false, detail: `no open '${p.label}' optimization ticket` };
      }
      const diff = extractTicketDiff(chosen.body);
      if (diff === undefined) {
        return { has_work: false, detail: `ticket #${chosen.number} carries no complete diff — re-propose it` };
      }
      picked.issue = chosen.number;
      return { has_work: true, issue_number: chosen.number, issue_title: chosen.title, diff };
    },
  });
}
