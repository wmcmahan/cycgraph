/**
 * The issue-fix topology: clone → pick → baseline → fix ⇄ judge/gate →
 * diff → review ⇄ review_check → commit → publish → report, with a single
 * giveup node draining every bounded dead end.
 *
 * The fixer and judge/gate form the correctness loop (bounded at three
 * consecutive gate failures); the reviewer and review_check form the
 * advisory loop (bounded at three rounds). A finding already gone, a spent
 * gate budget, or a never-approving review all route to giveup, which
 * flags the issue and ends at report.
 *
 * The graph-owned nodes come from {@link nodes/index.ts}; the delivery
 * nodes (clone/commit/publish) come from `deliveryNodes` in the composer.
 * This file owns only how they connect and the run's start state.
 *
 * @module maintenance/issue-fix/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { deliveryNodes } from '@cycgraph/tools/git';
import type { IssueFixContext } from './context.js';
import type { IssueFixNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one issue-fix run. */
export function issueFixGraph(
  c: IssueFixContext,
  nodes: IssueFixNodes,
  delivery: ReturnType<typeof deliveryNodes>,
) {
  const { pick, baseline, fix, judge, checks, gate, diff, review, reviewCheck, giveUp, report } = nodes;
  const { clone, commit, publish } = delivery;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'issue-fix',
      description: 'Fix one approved upkeep issue and prove the work was done.',
      nodes: [clone, pick, baseline, fix, judge, checks, gate, diff, review, reviewCheck, giveUp, commit, publish, report],
      edges: [
        { from: clone, to: pick },
        { from: pick, to: baseline, when: `memory.${pick.result}.has_work` },
        // No approved work is a clean outcome, not a failure.
        { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
        { from: baseline, to: fix, when: `memory.${baseline.result}.has_target` },
        // A finding already gone means the issue outlived its cause: no PR
        // is possible, and leaving the issue approved would let the next
        // dispatch pick the same one, so a human is flagged.
        { from: baseline, to: giveUp, when: `not memory.${baseline.result}.has_target` },
        { from: fix, to: judge },
        { from: judge, to: checks },
        { from: checks, to: gate },
        { from: gate, to: diff, when: 'memory.gate_verification_passed' },
        { from: diff, to: review },
        { from: review, to: reviewCheck },
        { from: reviewCheck, to: commit, when: `memory.${reviewCheck.result}.approved` },
        // Findings loop back to the fixer, bounded; a review that never
        // approves flags a human rather than delivering, so the issue stops
        // being the picker's top pick.
        {
          from: reviewCheck,
          to: fix,
          when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round < 3`,
        },
        {
          from: reviewCheck,
          to: giveUp,
          when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round >= 3`,
        },
        // Bounded at three CONSECUTIVE gate failures: each retry re-runs the
        // full checks, and `nextGateAttempt` restarts the count whenever the
        // previous gate passed, so the review loop's re-judging never spends
        // this budget.
        {
          from: gate,
          to: fix,
          when: 'not memory.gate_verification_passed and memory.judge_result.attempts < 3',
        },
        {
          from: gate,
          to: giveUp,
          when: 'not memory.gate_verification_passed and memory.judge_result.attempts >= 3',
        },
        { from: giveUp, to: report },
        { from: commit, to: publish },
        { from: publish, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      goal: 'Resolve one approved upkeep issue.',
      maxIterations: 40,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: {},
  };
}
