/**
 * The tune topology: sense → propose ⇄ shape/shaped → trial → won →
 * ticket → report.
 *
 * The analyst and the shaped gate form the proposal-shaping loop, bounded
 * by the attempt budget; a shaped edit is trialled, and only a variant that
 * measurably wins is ticketed. No signal, never shaping a valid proposal,
 * and a losing variant all end cleanly at report. The nodes come pre-built
 * from {@link nodes/index.ts}; this file owns only how they connect and the
 * run's start state.
 *
 * @module maintenance/tune/graph
 */

import { graph } from '@cycgraph/orchestrator';
import { tierResolver } from '../shared/models.js';
import type { TuneContext } from './context.js';
import type { TuneNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one tune run. */
export function tuneGraph(c: TuneContext, nodes: TuneNodes) {
  const { sense, propose, shape, shaped, trial, won, ticket, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'tune',
      description: 'Sense a workflow\'s failures, propose a source edit, trial it, ticket a winner.',
      nodes: [sense, propose, shape, shaped, trial, won, ticket, report],
      edges: [
        { from: sense, to: propose, when: `memory.${sense.result}.has_signal` },
        { from: sense, to: report, when: `not memory.${sense.result}.has_signal` },
        { from: propose, to: shape },
        { from: shape, to: shaped },
        { from: shaped, to: trial, when: 'memory.shaped_verification_passed' },
        {
          from: shaped,
          to: propose,
          when: `not memory.shaped_verification_passed and memory.${shape.result}.round < ${p.attempts}`,
        },
        // Never shaping a valid proposal is a clean no-proposal exit.
        {
          from: shaped,
          to: report,
          when: `not memory.shaped_verification_passed and memory.${shape.result}.round >= ${p.attempts}`,
        },
        { from: trial, to: won },
        { from: won, to: ticket, when: 'memory.won_verification_passed' },
        // A losing variant ends cleanly: the measurement was the work.
        { from: won, to: report, when: 'not memory.won_verification_passed' },
        { from: ticket, to: report },
      ],
      startNode: sense,
      endNodes: [report],
    }),
    input: {
      goal: `Propose one measured improvement to ${p.target}.`,
      maxIterations: 6 + p.attempts * 3,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: { modelResolver: tierResolver(c.env) },
  };
}
