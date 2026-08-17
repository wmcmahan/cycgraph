/**
 * Tail cost estimation
 *
 * What a fork is about to spend, predicted from what the same nodes cost in
 * the run it forks. `state.node_breakdown` already carries per-node
 * `cost_usd`, so the estimate needs no pricing model and no model call.
 *
 * It is an estimate and the report says so. A tail that diverges runs
 * different nodes than the base did, and the nodes it shares may cost
 * differently on a different model or a longer context. It is accurate enough
 * for the two jobs it has: refusing a fork that cannot afford its own tail,
 * and telling someone what a sweep is about to cost before they run it.
 *
 * @module replay/estimate
 */

import type { WorkflowState } from '../state/state.js';

/** A prediction of what a forked tail will spend. */
export interface TailEstimate {
  /** Predicted spend, in USD. */
  costUsd: number;
  /** Nodes expected to run, in the order the base run reached them. */
  nodes: string[];
  /** Budget left at the fork point, `null` when the run has no cost cap. */
  headroomUsd: number | null;
  /** True when the predicted spend exceeds the remaining budget. */
  exceedsBudget: boolean;
}

/**
 * Predict a tail's spend from the base run's per-node costs.
 *
 * The tail is taken to be the part of the base run's path the prefix has not
 * reached. `visited_nodes` is capped by the state schema, so on a very long run
 * the tail is under-counted rather than over-counted — the estimate errs toward
 * letting a fork proceed rather than refusing one that would have fit.
 *
 * @param baseState   The base run's final state.
 * @param prefixState The reconstructed state the fork starts from.
 */
export function estimateTailCost(
  baseState: WorkflowState,
  prefixState: WorkflowState,
): TailEstimate {
  const remaining = baseState.visited_nodes.slice(prefixState.visited_nodes.length - 1);
  const nodes = remaining.length > 0 ? remaining : [];

  // A node reached more than once in the tail costs its per-call average each
  // time, not its whole recorded total.
  const costUsd = nodes.reduce((total, nodeId) => {
    const entry = baseState.node_breakdown[nodeId];
    if (!entry || entry.calls === 0) return total;
    return total + entry.cost_usd / entry.calls;
  }, 0);

  const headroomUsd = prefixState.budget_usd === undefined
    ? null
    : prefixState.budget_usd - prefixState.total_cost_usd;

  return {
    costUsd,
    nodes,
    headroomUsd,
    exceedsBudget: headroomUsd !== null && costUsd > headroomUsd,
  };
}

/** Render an estimate as the line a report or a refusal shows. */
export function formatEstimate(estimate: TailEstimate): string {
  const nodes = estimate.nodes.length === 1
    ? '1 node'
    : `${estimate.nodes.length} nodes`;
  const headroom = estimate.headroomUsd === null
    ? 'no budget cap'
    : `$${estimate.headroomUsd.toFixed(4)} of budget left`;
  return `~$${estimate.costUsd.toFixed(4)} over ${nodes}, ${headroom}`;
}
