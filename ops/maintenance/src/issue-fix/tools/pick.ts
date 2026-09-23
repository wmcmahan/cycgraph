/**
 * pick_issue — choose the issue to fix, or run detached on a key.
 *
 * Two paths: when the issue ledger is readable, pick the oldest approved
 * issue that carries a finding marker (worst severity first), recording it
 * on the shared `picked` holder so onFatal can flag it. When the ledger is
 * unreadable, a `--key` runs the same cycle detached — the finding named
 * directly, nothing closed — which is what makes the loop testable without
 * GitHub.
 *
 * @module maintenance/issue-fix/tools/pick
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { listOpenIssues } from '@cycgraph/tools/git';
import { auditTitle, severityRank } from '../../repo-audit/findings.js';
import { findingFromKey, parseIssueFinding } from '../judge.js';
import type { IssueFixContext } from '../context.js';

/** The issue-picking tool, bound to the run's context. */
export function pickTool(c: IssueFixContext) {
  const { repoRoot, token, params: p, maintenance: ctx, picked } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'pick_issue',
    description: 'Pick the oldest approved upkeep issue, or run detached on a named key.',
    parameters: z.object({}),
    timeoutMs: 60_000,
    execute: async () => {
      const issues = await listOpenIssues(repoRoot, { label: p.label, ...auth });

      // 1. Ledger path: the oldest approved issue carrying a finding marker.
      if (issues !== undefined) {
        const candidates = issues
          .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
          // An issue the loop already gave up on waits for a human;
          // removing the label re-queues it, and naming the issue
          // explicitly overrides the skip — a targeted dispatch is the
          // human deciding.
          .filter((issue) => p.issueNumber !== 0 || !issue.labels.includes(ctx.labels.needsHuman))
          .flatMap((issue) => {
            const finding = parseIssueFinding(issue.body, ctx.markerNamespace);
            return finding !== undefined ? [{ issue, finding }] : [];
          })
          // Queue order: worst severity label first, oldest within.
          .sort((a, b) =>
            severityRank(a.issue.labels) - severityRank(b.issue.labels)
            || a.issue.number - b.issue.number);
        const chosen = candidates[0];
        if (chosen === undefined) {
          return { has_work: false, detail: `no open '${p.label}' issue carries a finding marker` };
        }
        picked.issue = chosen.issue.number;
        return {
          has_work: true,
          issue_number: chosen.issue.number,
          ...chosen.finding,
          // An audit finding lives in its issue text, not in the tree;
          // carry it forward so the baseline can brief the fixer.
          ...(chosen.finding.kind === 'audit'
            ? { issue_title: chosen.issue.title, issue_body: chosen.issue.body.slice(0, 12_000) }
            : {}),
        };
      }

      // 2. Detached path: fix a named key directly, closing nothing.
      if (p.key !== '') {
        const finding = findingFromKey(p.key);
        if (finding === undefined) {
          return {
            has_work: false,
            detail: `'${p.key}' is not a finding key ('<kind>:<file>:<detail>' or 'audit:<title-slug>')`,
          };
        }
        // `audit:<title-slug>` carries no file component and no
        // specification: an audit finding's evidence, detail and
        // suggestion live only in its issue text, so detached mode needs
        // that body handed in rather than guessed from the key.
        if (finding.kind === 'audit') {
          const body = p.ticketFile !== '' ? await readFile(p.ticketFile, 'utf8') : '';
          if (body.trim() === '') {
            return {
              has_work: false,
              detail: `'${p.key}' is an audit finding: its specification is the issue text, so detached mode needs --ticketFile carrying that body — the key alone is insufficient`,
            };
          }
          return {
            has_work: true,
            detached: true,
            ...finding,
            issue_title: auditTitle(body, p.key),
            issue_body: body.slice(0, 12_000),
          };
        }
        return { has_work: true, detached: true, ...finding };
      }

      return { has_work: false, detail: 'cannot read the issue ledger and no --key was given' };
    },
  });
}
