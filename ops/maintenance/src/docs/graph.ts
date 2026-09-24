/**
 * The docs-maintenance topology: clone → scan → fix → judge/gate → commit
 * ⇄ scan (batch) → publish → report, with an optional reflection tail.
 *
 * The fixer and gate form the per-finding retry loop; an abandoned finding
 * routes back to scan to take the next one; commit loops back to scan until
 * the batch quota is met. Nothing to fix at all is a clean outcome. The
 * graph-owned nodes come from {@link nodes/index.ts}; the delivery nodes
 * (clone/commit/publish) come from `deliveryNodes` in the composer.
 *
 * @module maintenance/docs/graph
 */

import { graph } from '@cycgraph/orchestrator';
import { tierResolver } from '../shared/models.js';
import type { deliveryNodes } from '@cycgraph/tools/git';
import type { DocsContext } from './context.js';
import type { DocsNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one docs run. */
export function docsGraph(
  c: DocsContext,
  nodes: DocsNodes,
  delivery: ReturnType<typeof deliveryNodes>,
) {
  const { scan, fix, judge, checks, gate, reflect, report } = nodes;
  const { clone, commit, publish } = delivery;
  const { params: p, id } = c;

  return {
    graph: graph({
      name: id,
      description: 'Fix mechanically-detected documentation staleness, and prove each fix.',
      nodes: [clone, scan, fix, judge, checks, gate, commit, publish, ...(reflect ? [reflect] : []), report],
      edges: [
        { from: clone, to: scan },
        { from: scan, to: fix, when: `memory.${scan.result}.has_finding` },
        // Out of findings after fixing some: deliver what landed.
        {
          from: scan,
          to: publish,
          when: `not memory.${scan.result}.has_finding and memory.${scan.result}.any_fixed`,
        },
        // Nothing to fix at all is a clean outcome, not a failure.
        {
          from: scan,
          to: report,
          when: `not memory.${scan.result}.has_finding and not memory.${scan.result}.any_fixed`,
        },
        { from: fix, to: judge },
        { from: judge, to: checks },
        { from: checks, to: gate },
        { from: gate, to: commit, when: 'memory.gate_verification_passed' },
        // A fix that did not land goes back for another attempt, bounded by
        // the run's iteration cap.
        {
          from: gate,
          to: fix,
          when: `not memory.gate_verification_passed and not memory.${judge.result}.gave_up`,
        },
        // A finding the judge has abandoned goes back to scan, which skips
        // it and takes the next one.
        {
          from: gate,
          to: scan,
          when: `not memory.gate_verification_passed and memory.${judge.result}.gave_up`,
        },
        // Batch: rescan for the next finding until the quota is met.
        {
          from: commit,
          to: scan,
          when: `memory.${commit.result}.committed and memory.${commit.result}.count < ${p.batch}`,
        },
        {
          from: commit,
          to: publish,
          when: `not memory.${commit.result}.committed or memory.${commit.result}.count >= ${p.batch}`,
        },
        // Learning tail: fixes delivered (or none found after fixing some)
        // flow through reflection so the run's working notes become
        // candidate lessons before the run ends.
        ...(reflect
          ? [{ from: publish, to: reflect }, { from: reflect, to: report }]
          : [{ from: publish, to: report }]),
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: {
      ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
      goal: p.batch > 1
        ? `Correct up to ${p.batch} stale claims in the documentation.`
        : 'Correct one stale claim in the documentation.',
      maxIterations: 13 + p.batch * 10,
    },
    runner: { modelResolver: tierResolver(c.env) },
  };
}
