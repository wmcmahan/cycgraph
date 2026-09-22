/**
 * implement-ticket — implement one approved feature ticket.
 *
 * The ambitious rung of the proposal ladder. The ticket is the spec: an
 * agent implements against its motivation, design sketch, and evidence, and
 * the judge is the ticket's own acceptance criteria — every criterion
 * shaped like a safe repository command is executed and must pass; the rest
 * are listed in the PR for the human review, which was always the feature
 * tier's real gate. A gate failure feeds the failing output back to the
 * agent, bounded by attempts.
 *
 * Only command shapes from the allowlist ever run (`safeAcceptanceCommand`):
 * an issue body is semi-trusted, so runnable criteria may invoke the
 * repository's own scripts and checkers, never arbitrary programs.
 * `--ticketFile` runs detached from GitHub.
 *
 * It is also the applier for `tune:` tickets, which carry a pre-measured
 * find/replace edit rather than a feature spec: that edit is applied
 * verbatim, with the repository checks as its guard, so the tune loop's
 * propose→approve→apply ladder closes here like every other one.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agents, the delivery nodes, the graph-owned
 * nodes, and the graph, and carries the onFatal that flags the picked issue
 * when an engine-level death bypasses giveup.
 *
 * @module maintenance/implement-ticket
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes } from '@cycgraph/tools/git';
import { fatalNeedsHuman } from '../shared/repo.js';
import { stripCloses, templateEvidence } from '../shared/pr-template.js';
import { buildImplementContext, params } from './context.js';
import type { Params } from './context.js';
import { implementTools } from './tools/index.js';
import { implementerAgent, reviewerAgent } from './agents/index.js';
import { implementNodes } from './nodes/index.js';
import { implementGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The implement-ticket workflow. */
export function featImplement(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'implement-ticket',
    title: 'Implement an approved feature ticket, or apply an approved tune edit',
    covers: ['maintenance', 'feature', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const c = await buildImplementContext(p, env);
      const tools = implementTools(c);
      const agents = { implementer: implementerAgent(c, tools), reviewer: reviewerAgent(c) };

      const delivery = deliveryNodes({
        repoRoot: c.repoRoot,
        workspaceAt: c.workspaceAt,
        branch: c.branchName,
        title: 'feat: implement an approved proposal',
        detailFrom: 'accept_result',
        evidence: (details: string[], ev: { diff: string }) => ({
          summary: `An approved feature ticket, implemented by the implement-ticket workflow. ${stripCloses(details).join(' ')}`.trim(),
          ...(details.length > 0 ? { changes: stripCloses(details) } : {}),
          provenance: 'implement-ticket: applied in a fresh clone and verified before commit — a feature ticket by its runnable acceptance criteria (the rest listed for this review), a tune ticket by its exact approved edit landing verbatim; the repository checks gate both.',
          ...templateEvidence(ev.diff, { checks: p.checks, reviewed: true, details }),
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const nodes = implementNodes(c, tools, agents);

      return {
        ...implementGraph(c, nodes, delivery),
        onFatal: fatalNeedsHuman(c.repoRoot, () => c.picked.issue, 'implement-ticket', c.maintenance.labels.needsHuman, c.token),
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
