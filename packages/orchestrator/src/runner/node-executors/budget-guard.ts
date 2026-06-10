/**
 * Composite-node budget guard.
 *
 * Per-node and workflow budgets are enforced by the GraphRunner only AFTER a
 * node's aggregated action returns. For composite nodes that issue many LLM
 * calls internally (evolution generations, annealing iterations), that makes
 * the budget a post-mortem rather than a cap — by the time the runner checks,
 * the whole population × generations spend already happened.
 *
 * This helper lets those executors check accumulated spend BETWEEN iterations
 * and stop early. It composes three caps:
 *   - the node's own `budget.max_tokens` / `budget.max_cost_usd`,
 *   - the remaining workflow cost budget at node entry.
 *
 * @module runner/node-executors/budget-guard
 */

import type { GraphNode } from '../../types/graph.js';
import { calculateCost } from '../../utils/pricing.js';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.budget-guard');

/** Running totals a composite executor accumulates as it spends. */
export interface CompositeSpend {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Model id observed from executed actions, for pricing. */
  model?: string;
}

export interface BudgetGuardDecision {
  /** True when the executor should stop issuing further LLM calls. */
  stop: boolean;
  /** Human-readable reason (for logs / diagnostics). */
  reason?: string;
}

/**
 * Decide whether a composite node should stop before its next internal batch.
 *
 * Conservative by design: it stops when accumulated spend has already met or
 * exceeded any configured cap, so the next batch (which would push further
 * past the cap) is never issued. The runner's post-node budget check still
 * runs and remains the authority on the final action.
 *
 * @param node - The composite node (carries optional `budget`).
 * @param spend - Accumulated token/cost totals so far.
 * @param ctx - Executor context (provides the remaining-workflow-budget getter).
 */
export function checkCompositeBudget(
  node: GraphNode,
  spend: CompositeSpend,
  ctx: NodeExecutorContext,
): BudgetGuardDecision {
  // Per-node token cap.
  if (node.budget?.max_tokens !== undefined && spend.totalTokens >= node.budget.max_tokens) {
    return { stop: true, reason: `node max_tokens reached (${spend.totalTokens}/${node.budget.max_tokens})` };
  }

  // Cost-based caps require a known model for pricing. If the model is
  // unknown (no actions executed yet, or unpriced model), skip cost checks —
  // the token cap and the runner's post-node check still apply.
  if (spend.model) {
    const costSoFar = calculateCost(spend.model, spend.inputTokens, spend.outputTokens);

    if (node.budget?.max_cost_usd !== undefined && costSoFar >= node.budget.max_cost_usd) {
      return { stop: true, reason: `node max_cost_usd reached ($${costSoFar.toFixed(4)}/$${node.budget.max_cost_usd})` };
    }

    // Remaining workflow budget snapshot at node entry. state.total_cost_usd
    // is not yet updated with this node's in-flight spend, so we subtract
    // costSoFar ourselves.
    const remainingWorkflow = ctx.getRemainingBudgetUsd?.();
    if (remainingWorkflow !== undefined && costSoFar >= remainingWorkflow) {
      return { stop: true, reason: `workflow budget would be exceeded ($${costSoFar.toFixed(4)} spent, $${remainingWorkflow.toFixed(4)} remained)` };
    }
  }

  return { stop: false };
}

/** Log a composite-budget early stop consistently across executors. */
export function logCompositeBudgetStop(nodeId: string, decision: BudgetGuardDecision): void {
  logger.warn('composite_budget_stop', { node_id: nodeId, reason: decision.reason });
}
