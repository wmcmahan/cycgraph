/**
 * issue-fix — the fix cycle over approved upkeep issues.
 *
 * code-scan files what the codebase owes; a human approves an issue by
 * labelling it; this workflow does the work. One issue per run: pick the
 * oldest approved issue carrying a finding marker, re-locate the finding in
 * a fresh clone (an issue whose finding is already gone routes to a clean
 * exit), fix it with an agent, judge with the class's anti-gaming guard
 * (`judge.ts`), run the repository's checks, pass a toolless reviewer over
 * the actual diff (advisory, bounded rounds — the mechanical gate stays the
 * gate), and deliver one PR whose body closes the issue. The human gates
 * are the label going in and the merge coming out.
 *
 * With no readable ledger, `--key` runs the same cycle detached — the
 * finding named directly, nothing closed — which is what makes the loop
 * testable without GitHub. An `audit:` key carries no file and no
 * specification, so detached mode pairs it with `--ticketFile`, whose
 * contents are the finding's issue text.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agents, the delivery nodes, the graph-owned
 * nodes, and the graph, each from its own file, and carries the onFatal
 * that flags the picked issue when an engine-level death bypasses giveup.
 *
 * @module maintenance/issue-fix
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes } from '@cycgraph/tools/git';
import { flagNeedsHuman } from '../shared/repo.js';
import { stripCloses, templateEvidence } from '../shared/pr-template.js';
import { buildIssueFixContext, params } from './context.js';
import type { Params } from './context.js';
import { issueFixTools } from './tools/index.js';
import { fixerAgent, reviewerAgent } from './agents/index.js';
import { issueFixNodes } from './nodes/index.js';
import { issueFixGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The issue-fix workflow. */
export function issueFix(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'issue-fix',
    title: 'Fix one approved finding from repo-audit or code-scan',
    covers: ['maintenance', 'upkeep', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const c = await buildIssueFixContext(p, env);
      const tools = issueFixTools(c);
      const agents = { fixer: fixerAgent(c, tools), reviewer: reviewerAgent(c) };

      const delivery = deliveryNodes({
        repoRoot: c.repoRoot,
        workspaceAt: c.workspaceAt,
        branch: c.branchName,
        title: 'chore: resolve owed upkeep',
        detailFrom: 'judge_result',
        evidence: (details: string[], ev: { diff: string; subjects: string[] }) => ({
          summary: `Filed by maintenance discovery (code-scan or repo-audit), approved by label, fixed by the issue-fix workflow. ${stripCloses(details).join(' ')}`.trim(),
          provenance: 'issue-fix: the finding was re-located mechanically, fixed by an agent in a jailed clone, and verified by re-scan, a class-specific anti-gaming guard, and repository checks before commit.',
          // The commit subjects name the changes; the judge's verdict prose
          // stays in the summary where it reads as provenance.
          ...(ev.subjects.length > 0
            ? { changes: ev.subjects }
            : details.length > 0 ? { changes: stripCloses(details) } : {}),
          ...templateEvidence(ev.diff, { checks: p.checks, reviewed: true, details }),
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const nodes = issueFixNodes(c, tools, agents);

      return {
        ...issueFixGraph(c, nodes, delivery),
        // An engine-level death (budget breach) bypasses the giveup node,
        // which would leave the picked issue approved-but-orphaned: its
        // label event already fired, so nothing re-queues it.
        onFatal: async (error: unknown) => {
          const issue = c.picked.issue;
          if (issue === undefined) return undefined;
          try {
            const reason = error instanceof Error ? error.message : String(error);
            const result = await flagNeedsHuman(c.repoRoot, issue, [
              `issue-fix died before finishing (${reason}), so this issue now carries the \`${c.maintenance.labels.needsHuman}\` label and the picker skips it.`,
              'Remove the label to re-queue it, or dispatch issue-fix naming this issue to override the skip.',
            ].join('\n'), { label: c.maintenance.labels.needsHuman, ...(c.token !== undefined ? { token: c.token } : {}) });
            return result.flagged
              ? `fatal-run cleanup: #${issue} flagged ${c.maintenance.labels.needsHuman}`
              : `fatal-run cleanup on #${issue}: ${result.detail}`;
          } catch (cleanupError) {
            return `fatal-run cleanup failed on #${issue}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        },
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
