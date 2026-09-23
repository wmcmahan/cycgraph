/**
 * optimization-apply — implement one approved optimization ticket.
 *
 * The mechanical rung of the proposal ladder: an approved optimization
 * ticket already carries a verified diff, so implementing it needs no model
 * at all. The run re-applies that diff to a fresh clone, re-benchmarks both
 * sides the same aliased way, and only a change that still measures —
 * improved beyond floor and noise, nothing regressed, checks green —
 * becomes the PR that closes the ticket. A diff that no longer applies, or
 * an improvement the current tree no longer shows, is refused honestly: the
 * remedy is a fresh optimization-propose run, not a force.
 *
 * `--ticketFile` runs the same cycle from a saved ticket body, closing
 * nothing — how this is testable without GitHub.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the delivery nodes, the graph-owned nodes, and the
 * graph, and carries the onFatal that flags the picked issue when an
 * engine-level death bypasses giveup.
 *
 * @module maintenance/optimization-apply
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes } from '@cycgraph/tools/git';
import { fatalNeedsHuman } from '../shared/repo.js';
import { stripCloses, templateEvidence } from '../shared/pr-template.js';
import { buildOptApplyContext, params } from './context.js';
import type { Params } from './context.js';
import { optApplyTools } from './tools/index.js';
import { optApplyNodes } from './nodes/index.js';
import { optApplyGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The optimization-apply workflow. */
export function optApply(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'optimization-apply',
    title: 'Re-apply and re-measure an approved optimization ticket, then open the PR',
    covers: ['maintenance', 'optimization', 'issues'],
    requires: [],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const c = await buildOptApplyContext(p, env);
      const tools = optApplyTools(c);

      const delivery = deliveryNodes({
        repoRoot: c.repoRoot,
        workspaceAt: c.workspaceAt,
        branch: c.branchName,
        title: 'perf: apply a measured optimization',
        detailFrom: 'verdict_result',
        evidence: (details: string[], ev: { diff: string }) => ({
          summary: `An approved optimization ticket, re-verified by the optimization-apply workflow. ${stripCloses(details).join(' ')}`.trim(),
          ...(details.length > 0 ? { changes: stripCloses(details) } : {}),
          provenance: 'optimization-apply: the ticket\'s verified diff was re-applied to a fresh clone and re-benchmarked; the improvement held beyond the floor and the noise, nothing regressed, and the checks passed.',
          ...templateEvidence(ev.diff, { checks: p.checks, details }),
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const nodes = optApplyNodes(tools);

      return {
        ...optApplyGraph(c, nodes, delivery),
        onFatal: fatalNeedsHuman(c.repoRoot, () => c.picked.issue, 'optimization-apply', c.maintenance.labels.needsHuman, c.token),
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
