/**
 * The optimization-apply topology: clone → pick → bench_before → apply →
 * bench_after → verdict → checks → gate → commit → publish → report, with a
 * giveup node draining the two dead ends (a diff that no longer applies, a
 * win that no longer measures).
 *
 * The graph-owned nodes come from {@link nodes/index.ts}; the delivery
 * nodes (clone/commit/publish) come from `deliveryNodes` in the composer.
 * This file owns only how they connect and the run's start state.
 *
 * @module maintenance/optimization-apply/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { deliveryNodes } from '@cycgraph/tools/git';
import type { OptApplyContext } from './context.js';
import type { OptApplyNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one apply run. */
export function optApplyGraph(
  c: OptApplyContext,
  nodes: OptApplyNodes,
  delivery: ReturnType<typeof deliveryNodes>,
) {
  const { pick, benchBefore, apply, benchAfter, verdict, checks, gate, giveUp, report } = nodes;
  const { clone, commit, publish } = delivery;

  return {
    graph: graph({
      name: 'optimization-apply',
      description: 'Re-apply an approved optimization\'s verified diff and prove it still measures.',
      nodes: [clone, pick, benchBefore, apply, benchAfter, verdict, checks, gate, giveUp, commit, publish, report],
      edges: [
        { from: clone, to: pick },
        { from: pick, to: benchBefore, when: `memory.${pick.result}.has_work` },
        { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
        { from: benchBefore, to: apply },
        { from: apply, to: benchAfter, when: `memory.${apply.result}.applied` },
        { from: apply, to: giveUp, when: `not memory.${apply.result}.applied` },
        { from: benchAfter, to: verdict },
        { from: verdict, to: checks },
        { from: checks, to: gate },
        { from: gate, to: commit, when: 'memory.gate_verification_passed' },
        { from: gate, to: giveUp, when: 'not memory.gate_verification_passed' },
        { from: giveUp, to: report },
        { from: commit, to: publish },
        { from: publish, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: { goal: 'Implement one approved optimization ticket.' },
    runner: {},
  };
}
