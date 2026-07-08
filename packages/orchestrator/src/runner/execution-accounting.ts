/**
 * Execution Accounting
 *
 * The per-action usage/budget stage of the execution loop: tracks
 * cumulative tokens, cost, and per-model usage from an applied action's
 * metadata, then enforces the per-node budget (`GraphNode.budget`) and
 * the workflow token budget.
 *
 * Written as an async generator so budget/threshold stream events are
 * yielded at exactly the same points as when this logic lived inline in
 * `GraphRunner.executeLoop` — threshold events surface before the
 * `action:applied` event that follows this stage.
 *
 * Budget breaches persist a failed state FIRST, then throw
 * ({@link NodeBudgetExceededError} / {@link BudgetExceededError}) — no
 * retry, since a retry would just compound the spend.
 *
 * @module runner/execution-accounting
 */

import type { GraphNode } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import type { StreamEvent } from './stream-events.js';
import type { BudgetMonitor } from './budget-monitor.js';
import { BudgetExceededError, NodeBudgetExceededError } from './errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.execution-accounting');

/** Live accessors into the owning runner. */
export interface ExecutionAccountingRuntime {
  /** Live state accessor — the runner's state object is reassigned per reduce. */
  getState: () => WorkflowState;
  /** Dispatch a trusted internal action (`_track_tokens`, `_fail`, …). */
  dispatchInternal: (type: string, payload?: Record<string, unknown>) => void;
  /** Persist the current state (used before throwing on a budget breach). */
  persistState: () => Promise<void>;
  /** Drain buffered stream events (threshold notifications) for yielding. */
  drainPendingEvents: () => Generator<StreamEvent>;
  /** Budget threshold tracker (cost math + threshold events). */
  budget: BudgetMonitor;
}

/**
 * Apply an action's token/cost/model usage to workflow state and enforce
 * the per-node and workflow budgets.
 *
 * @throws {NodeBudgetExceededError} When `node.budget` caps are breached.
 * @throws {BudgetExceededError} When the workflow token budget is breached.
 */
export async function* applyUsageAndEnforceBudgets(
  action: Action,
  node: GraphNode,
  rt: ExecutionAccountingRuntime,
): AsyncGenerator<StreamEvent> {
  // Track cumulative token usage from agent/supervisor executions
  const tokenUsage = action.metadata.token_usage;
  if (tokenUsage?.totalTokens && typeof tokenUsage.totalTokens === 'number') {
    rt.dispatchInternal('_track_tokens', {
      tokens: tokenUsage.totalTokens,
      input_tokens: tokenUsage.inputTokens ?? 0,
      output_tokens: tokenUsage.outputTokens ?? 0,
    });
  }

  // Track cumulative cost from token usage. Also compute the
  // per-action cost so the per-node budget check below has it. A
  // pre-computed `costUsd` (composite executors like subgraph, whose
  // spend spans multiple models) is used directly; otherwise cost is
  // derived from this action's tokens + model.
  let actionCostUsd = 0;
  if (
    tokenUsage?.inputTokens !== undefined ||
    tokenUsage?.outputTokens !== undefined ||
    tokenUsage?.costUsd !== undefined
  ) {
    const inputTokens = tokenUsage.inputTokens ?? 0;
    const outputTokens = tokenUsage.outputTokens ?? 0;
    actionCostUsd = tokenUsage.costUsd !== undefined
      ? tokenUsage.costUsd
      : rt.budget.calculateActionCost(inputTokens, outputTokens, action);
    if (actionCostUsd > 0) {
      rt.dispatchInternal('_track_cost', { cost_usd: actionCostUsd });
      await rt.budget.checkThresholds(rt.getState());
      yield* rt.drainPendingEvents();
    }
    // Attribute this call's tokens/cost to its model for per-model
    // billing rollups. Tracked even when cost is 0 (unknown pricing or
    // local models) so token usage is still attributed.
    const model = action.metadata.model;
    if (model && (inputTokens > 0 || outputTokens > 0)) {
      rt.dispatchInternal('_track_model_usage', {
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: actionCostUsd,
      });
    }
  }

  // Enforce per-node budget (max_tokens / max_cost_usd). Stops the
  // workflow immediately on breach — no retry, since a retry would
  // just compound the spend.
  if (node.budget) {
    const nodeTokens = tokenUsage?.totalTokens ?? 0;
    if (
      node.budget.max_tokens !== undefined &&
      nodeTokens > node.budget.max_tokens
    ) {
      logger.warn('node_budget_exceeded', {
        node_id: node.id,
        limit: 'max_tokens',
        used: nodeTokens,
        cap: node.budget.max_tokens,
      });
      rt.dispatchInternal('_fail', {
        last_error: `Node "${node.id}" exceeded max_tokens: ${nodeTokens} > ${node.budget.max_tokens}`,
      });
      await rt.persistState();
      yield* rt.drainPendingEvents();
      throw new NodeBudgetExceededError(
        node.id,
        'max_tokens',
        nodeTokens,
        node.budget.max_tokens,
      );
    }
    if (
      node.budget.max_cost_usd !== undefined &&
      actionCostUsd > node.budget.max_cost_usd
    ) {
      logger.warn('node_budget_exceeded', {
        node_id: node.id,
        limit: 'max_cost_usd',
        used: actionCostUsd,
        cap: node.budget.max_cost_usd,
      });
      rt.dispatchInternal('_fail', {
        last_error: `Node "${node.id}" exceeded max_cost_usd: $${actionCostUsd.toFixed(4)} > $${node.budget.max_cost_usd.toFixed(4)}`,
      });
      await rt.persistState();
      yield* rt.drainPendingEvents();
      throw new NodeBudgetExceededError(
        node.id,
        'max_cost_usd',
        actionCostUsd,
        node.budget.max_cost_usd,
      );
    }
  }

  // Enforce token budget
  const state = rt.getState();
  if (state.max_token_budget && state.total_tokens_used > state.max_token_budget) {
    const errorMsg = `Token budget exceeded: ${state.total_tokens_used} tokens used, budget was ${state.max_token_budget}`;
    logger.warn('budget_exceeded', {
      total_tokens: state.total_tokens_used,
      budget: state.max_token_budget,
      node_id: node.id,
    });
    rt.dispatchInternal('_budget_exceeded', { last_error: errorMsg });
    await rt.persistState();
    yield* rt.drainPendingEvents();
    throw new BudgetExceededError(state.total_tokens_used, state.max_token_budget);
  }
}
