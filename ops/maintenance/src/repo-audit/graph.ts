/**
 * The repo-audit topology: clone → audit (fan-out) → sift → gate → ticket
 * → report, with an optional reflection tail between sift and gate.
 *
 * The `audit` map node fans `audit_worker` over the charter list, so the
 * worker sits in the graph beside it. Learning sits between sift and gate
 * so clean audits teach too. A clean audit and a failed fan-out both end at
 * report; the gate boolean and the sift accounting say which happened.
 *
 * The nodes come pre-built from {@link nodes/index.ts}; this file owns only
 * how they connect and the run's start state.
 *
 * @module maintenance/repo-audit/graph
 */

import { graph } from '@cycgraph/orchestrator';
import { tierResolver } from '../shared/models.js';
import type { RepoAuditContext } from './context.js';
import type { RepoAuditNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one repo-audit run. */
export function repoAuditGraph(c: RepoAuditContext, nodes: RepoAuditNodes) {
  const { clone, worker, audit, sift, reflect, gate, ticket, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'repo-audit',
      description: 'Fan out read-only auditors; sifted, evidence-checked findings become tickets.',
      nodes: [clone, audit, worker, sift, ...(reflect ? [reflect] : []), gate, ticket, report],
      edges: [
        { from: clone, to: audit },
        { from: audit, to: sift },
        // Learning sits between sift and gate so clean audits teach too —
        // "this charter came back clean again" is a lesson.
        ...(reflect
          ? [{ from: sift, to: reflect }, { from: reflect, to: gate }]
          : [{ from: sift, to: gate }]),
        {
          from: gate,
          to: ticket,
          when: `memory.gate_verification_passed and memory.${sift.result}.kept_count > 0`,
        },
        // A clean audit and a failed fan-out both end at report; the gate
        // boolean and the sift accounting say which happened.
        {
          from: gate,
          to: report,
          when: `not memory.gate_verification_passed or memory.${sift.result}.kept_count == 0`,
        },
        { from: ticket, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      goal: `Audit the repository under up to ${p.maxAuditors} charters and file the strongest findings.`,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
      maxIterations: 9,
    },
    runner: { modelResolver: tierResolver(c.env) },
  };
}
