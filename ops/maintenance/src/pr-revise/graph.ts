/**
 * The pr-revise topology: gather → revise ⇄ checks/gate → deliver → report.
 *
 * The reviser and checks form the retry loop — the gate sends a revision
 * that changed nothing, or failed the checks, back to the reviser — and
 * only a clean, tree-changing pass reaches delivery. A run that finds no
 * feedback to address routes straight to `report`.
 *
 * The nodes come pre-built from {@link nodes/index.ts}; this file owns
 * only how they connect and the run's start state.
 *
 * @module maintenance/pr-revise/graph
 */

import { graph } from '@cycgraph/orchestrator';
import { tierResolver } from '../shared/models.js';
import type { ReviseContext } from './context.js';
import type { ReviseNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one pr-revise run. */
export function reviseGraph(c: ReviseContext, nodes: ReviseNodes) {
  const { gather, revise, checks, gate, deliver, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'pr-revise',
      description: 'Turn human review feedback into a revision commit on the same PR.',
      nodes: [gather, revise, checks, gate, deliver, report],
      edges: [
        { from: gather, to: revise, when: `memory.${gather.result}.has_work` },
        { from: gather, to: report, when: `not memory.${gather.result}.has_work` },
        { from: revise, to: checks },
        { from: checks, to: gate },
        { from: gate, to: deliver, when: 'memory.gate_verification_passed' },
        { from: gate, to: revise, when: 'not memory.gate_verification_passed' },
        { from: deliver, to: report },
      ],
      startNode: gather,
      endNodes: [report],
    }),
    input: {
      goal: `Address review feedback on PR #${p.pr}.`,
      maxIterations: 4 + p.attempts * 3,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: { modelResolver: tierResolver(c.env) },
  };
}
