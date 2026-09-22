/**
 * The optimization-propose topology: clone → bench_before → propose ⇄
 * bench_after → verdict → checks → gate → ticket → report.
 *
 * The optimizer and the gate form the retry loop — a proposal that did not
 * measure a win, regressed, or left the scope loops back — and only a
 * verified improvement reaches the ticket. The nodes come pre-built from
 * {@link nodes/index.ts}; this file owns only how they connect and the
 * run's start state.
 *
 * @module maintenance/optimization-propose/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { OptProposeContext } from './context.js';
import type { OptProposeNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one propose run. */
export function optProposeGraph(c: OptProposeContext, nodes: OptProposeNodes) {
  const { clone, benchBefore, propose, benchAfter, verdict, checks, gate, ticket, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'optimization-propose',
      description: 'Measure, optimize, re-measure; a verified improvement becomes a ticket.',
      nodes: [clone, benchBefore, propose, benchAfter, verdict, checks, gate, ticket, report],
      edges: [
        { from: clone, to: benchBefore },
        { from: benchBefore, to: propose },
        { from: propose, to: benchAfter },
        { from: benchAfter, to: verdict },
        { from: verdict, to: checks },
        { from: checks, to: gate },
        { from: gate, to: ticket, when: 'memory.gate_verification_passed' },
        { from: gate, to: propose, when: 'not memory.gate_verification_passed' },
        { from: ticket, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      goal: 'Propose one measured optimization.',
      maxIterations: 6 + p.attempts * 6,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: {},
  };
}
