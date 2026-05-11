/**
 * Budget Monitor
 *
 * Tracks cost accrual and fires threshold alerts as a workflow approaches
 * its `budget_usd` ceiling. Throws {@link BudgetExceededError} at 100%.
 *
 * ## Contract: push-via-callback (do not return arrays)
 *
 * The runner drains its pending-events queue *between* `checkThresholds` and
 * the subsequent `action:applied` yield. Returning events as an array would
 * let a future caller drain them out of order and silently break the
 * streaming-order invariant tests assert. Instead the monitor takes callbacks
 * (`dispatch`, `push`, `emit`) and the runner stays in control of when each
 * fires.
 *
 * Idempotency of threshold emissions is enforced by the
 * `_fire_cost_threshold` internal action — the monitor calls `dispatch()`
 * which mutates `state._cost_alert_thresholds_fired`. Subsequent calls skip
 * thresholds already in that array.
 *
 * @module runner/budget-monitor
 */

import type { Action, WorkflowState } from '../types/state.js';
import type { StreamEvent } from './stream-events.js';
import { BudgetExceededError } from './errors.js';
import { calculateCost } from '../utils/pricing.js';

/** Threshold fractions of `budget_usd` that fire alerts. 1.0 is fatal. */
const THRESHOLDS = [0.5, 0.75, 0.9, 1.0] as const;

/** Callbacks the runner provides so the monitor can interact with its state. */
export interface BudgetMonitorCallbacks {
  /**
   * Dispatch an internal action through the runner's reducer pipeline.
   * Used to record fired thresholds (`_fire_cost_threshold`) and the terminal
   * `_budget_exceeded` transition.
   */
  dispatch: (type: '_fire_cost_threshold' | '_budget_exceeded', payload: Record<string, unknown>) => void;

  /**
   * Push a `budget:threshold_reached` stream event to the runner's pending
   * queue. Only invoked when the runner is in streaming mode — the runner
   * decides whether to call this via its `isStreaming` predicate.
   */
  push: (event: StreamEvent) => void;

  /** Whether the runner is currently in `stream()` mode. */
  isStreaming: () => boolean;

  /** EventEmitter passthrough — runner.emit. */
  emit: (event: 'budget:threshold_reached', payload: {
    run_id: string;
    workflow_id: string;
    threshold_pct: number;
    cost_usd: number;
    budget_usd: number;
  }) => void;
}

/**
 * Per-runner budget tracker. One instance per `GraphRunner` lifetime.
 */
export class BudgetMonitor {
  constructor(private readonly callbacks: BudgetMonitorCallbacks) {}

  /**
   * Cost of a single action's LLM call. Falls back to 0 for unknown models.
   * Pure — no callbacks invoked.
   */
  calculateActionCost(inputTokens: number, outputTokens: number, action: Action): number {
    const modelHint = action.metadata.model ?? '';
    return calculateCost(modelHint, inputTokens, outputTokens);
  }

  /**
   * Check whether cost crossed any threshold since the last call.
   *
   * Order of effects per crossed threshold:
   *   1. `dispatch('_fire_cost_threshold')` — updates state for idempotency
   *   2. `emit('budget:threshold_reached')` — synchronous EventEmitter
   *   3. `push(streamEvent)` — only when `isStreaming()`
   *   4. At 100%: `dispatch('_budget_exceeded')` then **throw**
   *
   * Throws {@link BudgetExceededError} when total cost meets or exceeds
   * `budget_usd`. The runner wraps the call in the same try/catch that
   * persistState() is wrapped in, so the throw propagates correctly.
   */
  async checkThresholds(state: WorkflowState): Promise<void> {
    const { budget_usd, total_cost_usd, _cost_alert_thresholds_fired } = state;
    if (!budget_usd || budget_usd <= 0) return;

    const usedPct = total_cost_usd / budget_usd;

    for (const threshold of THRESHOLDS) {
      if (usedPct >= threshold && !_cost_alert_thresholds_fired.includes(threshold)) {
        this.callbacks.dispatch('_fire_cost_threshold', { threshold });
        this.callbacks.emit('budget:threshold_reached', {
          run_id: state.run_id,
          workflow_id: state.workflow_id,
          threshold_pct: Math.round(threshold * 100),
          cost_usd: total_cost_usd,
          budget_usd,
        });

        if (this.callbacks.isStreaming()) {
          this.callbacks.push({
            type: 'budget:threshold_reached',
            run_id: state.run_id,
            workflow_id: state.workflow_id,
            threshold_pct: Math.round(threshold * 100),
            cost_usd: total_cost_usd,
            budget_usd,
            timestamp: Date.now(),
          });
        }

        if (threshold >= 1.0) {
          const errorMsg = `Cost budget exceeded: $${total_cost_usd.toFixed(4)} used, budget was $${budget_usd.toFixed(4)}`;
          this.callbacks.dispatch('_budget_exceeded', { last_error: errorMsg });
          throw new BudgetExceededError(total_cost_usd, budget_usd);
        }
      }
    }
  }
}
