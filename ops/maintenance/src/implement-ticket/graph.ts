/**
 * The implement-ticket topology: clone → pick → implement ⇄ accept/gate →
 * diff → review ⇄ review_check → commit → publish → report, with a giveup
 * node for the never-approving review.
 *
 * The implementer and accept/gate form the correctness loop; the reviewer
 * and review_check form the advisory loop (bounded at three rounds). The
 * graph-owned nodes come from {@link nodes/index.ts}; the delivery nodes
 * (clone/commit/publish) come from `deliveryNodes` in the composer.
 *
 * @module maintenance/implement-ticket/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { deliveryNodes } from '@cycgraph/tools/git';
import type { ImplementContext } from './context.js';
import type { ImplementNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one implement run. */
export function implementGraph(
  c: ImplementContext,
  nodes: ImplementNodes,
  delivery: ReturnType<typeof deliveryNodes>,
) {
  const { pick, implement, accept, checks, gate, diff, review, reviewCheck, giveUp, report } = nodes;
  const { clone, commit, publish } = delivery;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'implement-ticket',
      description: 'Implement an approved feature ticket against its own acceptance criteria.',
      nodes: [clone, pick, implement, accept, checks, gate, diff, review, reviewCheck, giveUp, commit, publish, report],
      edges: [
        { from: clone, to: pick },
        { from: pick, to: implement, when: `memory.${pick.result}.has_work` },
        { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
        { from: implement, to: accept },
        { from: accept, to: checks },
        { from: checks, to: gate },
        { from: gate, to: diff, when: 'memory.gate_verification_passed' },
        { from: diff, to: review },
        { from: review, to: reviewCheck },
        { from: reviewCheck, to: commit, when: `memory.${reviewCheck.result}.approved` },
        // Findings loop back to the implementer, bounded; a review that
        // never approves flags a human rather than delivering, so the issue
        // stops being the picker's top pick and the run reports it gave up.
        {
          from: reviewCheck,
          to: implement,
          when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round < 3`,
        },
        {
          from: reviewCheck,
          to: giveUp,
          when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round >= 3`,
        },
        { from: gate, to: implement, when: 'not memory.gate_verification_passed' },
        { from: giveUp, to: report },
        { from: commit, to: publish },
        { from: publish, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      goal: 'Implement one approved feature ticket.',
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
      maxIterations: 10 + p.attempts * 9,
    },
    runner: {},
  };
}
