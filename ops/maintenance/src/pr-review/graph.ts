/**
 * The pr-review topology: gather → review → verdict → deliver → report,
 * with a diff-only fallback loop on an inconclusive verdict and an
 * optional reflection tail.
 *
 * A run that finds no PR to review routes straight to report. An
 * inconclusive review (no VERDICT marker) retries once through the
 * toolless diff-only reviewer; a second failure flows to deliver, which
 * posts the trace comment. When memory is on, deliver feeds a reflection
 * node before report.
 *
 * The nodes come pre-built from {@link nodes/index.ts}; this file owns only
 * how they connect and the run's start state.
 *
 * @module maintenance/pr-review/graph
 */

import { graph } from '@cycgraph/orchestrator';
import { tierResolver } from '../shared/models.js';
import type { ReviewContext } from './context.js';
import type { ReviewNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one pr-review run. */
export function reviewGraph(c: ReviewContext, nodes: ReviewNodes) {
  const { gather, review, reviewFallback, verdict, deliver, reflect, report } = nodes;
  const { params: p } = c;

  return {
    graph: graph({
      name: 'pr-review',
      description: 'Read a PR beside its codebase and post an advisory review.',
      nodes: [gather, review, reviewFallback, verdict, deliver, ...(reflect ? [reflect] : []), report],
      edges: [
        { from: gather, to: review, when: `memory.${gather.result}.has_work` },
        { from: gather, to: report, when: `not memory.${gather.result}.has_work` },
        { from: review, to: verdict },
        { from: verdict, to: reviewFallback, when: `memory.${verdict.result}.malformed and memory.${verdict.result}.round < 2` },
        { from: reviewFallback, to: verdict },
        { from: verdict, to: deliver, when: `not memory.${verdict.result}.malformed or memory.${verdict.result}.round >= 2` },
        ...(reflect
          ? [{ from: deliver, to: reflect }, { from: reflect, to: report }]
          : [{ from: deliver, to: report }]),
      ],
      startNode: gather,
      endNodes: [report],
    }),
    input: {
      goal: `Review pull request #${p.pr}.`,
      maxIterations: 12,
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
    },
    runner: { modelResolver: tierResolver(c.env) },
  };
}
