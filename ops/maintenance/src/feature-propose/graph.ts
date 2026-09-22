/**
 * The feature-propose topology: clone → survey → propose ⇄ shape/gate →
 * ticket → report.
 *
 * The drafter and the gate form the retry loop, bounded by the attempt
 * budget; a drafter that never shapes a valid proposal is a clean
 * no-proposal outcome, not a failed run. The nodes come pre-built from
 * {@link nodes/index.ts}; this file owns only how they connect and the
 * run's start state.
 *
 * @module maintenance/feature-propose/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { FeatProposeContext } from './context.js';
import type { FeatProposeNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one propose run. */
export function featProposeGraph(c: FeatProposeContext, nodes: FeatProposeNodes) {
  const { clone, survey, propose, shape, gate, ticket, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'feature-propose',
      description: 'Study the codebase read-only; a reviewable feature proposal becomes a ticket.',
      nodes: [clone, survey, propose, shape, gate, ticket, report],
      edges: [
        { from: clone, to: survey },
        { from: survey, to: propose },
        { from: propose, to: shape },
        { from: shape, to: gate },
        { from: gate, to: ticket, when: 'memory.gate_verification_passed' },
        {
          from: gate,
          to: propose,
          when: `not memory.gate_verification_passed and memory.${shape.result}.round < ${p.attempts}`,
        },
        {
          from: gate,
          to: report,
          when: `not memory.gate_verification_passed and memory.${shape.result}.round >= ${p.attempts}`,
        },
        { from: ticket, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      goal: 'Propose one well-formed feature.',
      maxIterations: 4 + p.attempts * 3,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: {},
  };
}
