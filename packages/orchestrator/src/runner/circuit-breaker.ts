/**
 * Circuit Breaker
 *
 * Implements the circuit breaker pattern for graph node execution.
 * Tracks per-node failure/success counts and transitions through
 * three states:
 *
 * ```
 * CLOSED ──(failures ≥ threshold)──▶ OPEN ──(timeout elapsed)──▶ HALF-OPEN
 *   ▲                                                                │
 *   └────────(successes ≥ threshold)─────────────────────────────────┘
 *   └────────────────────────(failure in half-open)──────────▶ OPEN
 * ```
 *
 * @module runner/circuit-breaker
 */

import type { GraphNode } from '../types/graph.js';
import { createLogger } from '../utils/logger.js';
import { CircuitBreakerOpenError } from './errors.js';

const logger = createLogger('runner.circuit-breaker');

/** Default timeout before allowing a half-open probe (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default consecutive failures before tripping the breaker. */
const DEFAULT_FAILURE_THRESHOLD = 5;
/** Default consecutive successes in half-open before closing. */
const DEFAULT_SUCCESS_THRESHOLD = 2;

/**
 * Per-node circuit breaker state.
 */
export interface CircuitBreakerState {
  /** Current breaker status. */
  status: 'closed' | 'open' | 'half-open';
  /** Consecutive failure count (resets on success). */
  failure_count: number;
  /** Consecutive success count (resets on failure). */
  success_count: number;
  /** Timestamp of the most recent failure (epoch ms). */
  last_failure_time?: number;
}

/**
 * Manages circuit breaker state for graph nodes.
 *
 * Tracks failures per node and trips/resets breakers based on
 * configured thresholds in each node's `failure_policy`.
 */
export class CircuitBreakerManager {
  private readonly breakers = new Map<string, CircuitBreakerState>();

  /**
   * Check whether the breaker allows execution.
   *
   * @throws {@link CircuitBreakerOpenError} If the breaker is open and the timeout has not elapsed.
   */
  check(node: GraphNode): void {
    const breakerState = this.breakers.get(node.id);
    if (!breakerState) return;

    if (breakerState.status === 'open') {
      const now = Date.now();
      const timeout = node.failure_policy.circuit_breaker?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      if (breakerState.last_failure_time && (now - breakerState.last_failure_time) < timeout) {
        throw new CircuitBreakerOpenError(node.id);
      }

      // Timeout elapsed → half-open: allow one probe attempt
      breakerState.status = 'half-open';
      breakerState.success_count = 0;
    }
  }

  /**
   * Update breaker state after a node execution attempt.
   *
   * @param node_id - The node that was executed.
   * @param success - Whether the execution succeeded.
   * @param nodes - All graph nodes (for threshold lookup).
   */
  update(node_id: string, success: boolean, nodes: readonly GraphNode[]): void {
    let state = this.breakers.get(node_id);

    if (!state) {
      state = { status: 'closed', failure_count: 0, success_count: 0 };
      this.breakers.set(node_id, state);
    }

    if (success) {
      state.success_count++;
      state.failure_count = 0;

      if (state.status === 'half-open') {
        const node = nodes.find(n => n.id === node_id);
        const threshold = node?.failure_policy.circuit_breaker?.success_threshold ?? DEFAULT_SUCCESS_THRESHOLD;

        if (state.success_count >= threshold) {
          state.status = 'closed';
          logger.info('circuit_breaker_closed', { node_id });
        }
      }
    } else {
      state.failure_count++;
      state.success_count = 0;
      state.last_failure_time = Date.now();

      if (state.status === 'closed') {
        const node = nodes.find(n => n.id === node_id);
        const threshold = node?.failure_policy.circuit_breaker?.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD;

        if (state.failure_count >= threshold) {
          state.status = 'open';
          logger.error('circuit_breaker_opened', undefined, { node_id, failure_count: state.failure_count });
        }
      } else if (state.status === 'half-open') {
        state.status = 'open';
      }
    }
  }
}
