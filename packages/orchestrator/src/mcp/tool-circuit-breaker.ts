/**
 * Per-Tool Circuit Breaker
 *
 * Protects MCP tool invocations from runaway failure cascades. A breaker is
 * tracked per `(serverId, toolName)` pair. The state machine mirrors the
 * node-level breaker in `execution/engine/circuit-breaker.ts` but operates at the tool
 * granularity, which is what we actually want when one tool on a multi-tool
 * server starts misbehaving — opening the per-tool breaker keeps healthy
 * tools on the same server usable.
 *
 * ```
 * CLOSED ──(failure_count ≥ failure_threshold)──▶ OPEN
 *   ▲                                                │
 *   │                                       (cooldown elapsed)
 *   │                                                │
 *   │                                                ▼
 *   └──────(success_count ≥ success_threshold)── HALF_OPEN
 *                                                    │
 *                          (any failure)──▶ OPEN ◀──┘
 * ```
 *
 * @module mcp/tool-circuit-breaker
 */

import { ToolCircuitBreakerOpenError } from './errors.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('mcp.tool-circuit-breaker');

/** Tuning knobs for the per-tool circuit breaker. */
export interface ToolCircuitBreakerOptions {
  /**
   * Consecutive failures that open the breaker.
   * @default 5
   */
  failure_threshold?: number;
  /**
   * Consecutive successes in `half_open` that close the breaker.
   * @default 2
   */
  success_threshold?: number;
  /**
   * Wall-clock window the breaker stays in `open` before transitioning to
   * `half_open` (ms).
   * @default 30000
   */
  cooldown_ms?: number;
}

/** Lifecycle state of a per-tool breaker. */
export type ToolCircuitBreakerStatus = 'closed' | 'open' | 'half_open';

/**
 * Observable state of a single tool's circuit breaker.
 *
 * Exposed via {@link ToolCircuitBreakerManager.getMetrics} for instrumentation.
 */
export interface ToolCircuitBreakerState {
  status: ToolCircuitBreakerStatus;
  /** Resets to zero on every success. */
  consecutive_failures: number;
  /** Counts successes only while in `half_open`. */
  consecutive_successes: number;
  /** Lifetime stats — never reset, useful for dashboards. */
  total_calls: number;
  total_failures: number;
  total_successes: number;
  /** Epoch ms the breaker last transitioned to `open`. */
  opened_at?: number;
}

/** Per-tool snapshot returned by `getMetrics()`. */
export interface ToolCircuitBreakerMetrics extends ToolCircuitBreakerState {
  server_id: string;
  tool_name: string;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Tracks per-tool breaker state and gates execution.
 *
 * Wire `check()` before invoking a tool and `recordSuccess()` / `recordFailure()`
 * after. All three operations are O(1).
 */
export class ToolCircuitBreakerManager {
  private readonly breakers = new Map<string, ToolCircuitBreakerState>();
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;

  constructor(options?: ToolCircuitBreakerOptions) {
    this.failureThreshold = options?.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.successThreshold = options?.success_threshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.cooldownMs = options?.cooldown_ms ?? DEFAULT_COOLDOWN_MS;
  }

  /** Composite key shared across all internal lookups. */
  private static key(serverId: string, toolName: string): string {
    return `${serverId}::${toolName}`;
  }

  /**
   * Throw {@link ToolCircuitBreakerOpenError} when the breaker is `open` and
   * the cooldown has not yet elapsed. Transitions `open → half_open` when the
   * cooldown has elapsed so the next call serves as the probe.
   */
  check(serverId: string, toolName: string): void {
    const state = this.breakers.get(ToolCircuitBreakerManager.key(serverId, toolName));
    if (!state || state.status === 'closed') return;

    if (state.status === 'open') {
      const elapsed = Date.now() - (state.opened_at ?? 0);
      if (elapsed < this.cooldownMs) {
        throw new ToolCircuitBreakerOpenError(serverId, toolName, this.cooldownMs - elapsed);
      }
      // Cooldown elapsed: allow one probe attempt.
      state.status = 'half_open';
      state.consecutive_successes = 0;
      logger.info('breaker_half_open', { server_id: serverId, tool_name: toolName });
    }
    // half_open: allow the call through. recordSuccess/recordFailure will
    // decide whether to fully close or re-open.
  }

  /** Record a successful tool invocation. */
  recordSuccess(serverId: string, toolName: string): void {
    const state = this.getOrCreate(serverId, toolName);
    state.total_calls++;
    state.total_successes++;
    state.consecutive_failures = 0;

    if (state.status === 'half_open') {
      state.consecutive_successes++;
      if (state.consecutive_successes >= this.successThreshold) {
        state.status = 'closed';
        state.opened_at = undefined;
        logger.info('breaker_closed', { server_id: serverId, tool_name: toolName });
      }
    }
  }

  /** Record a failed tool invocation. */
  recordFailure(serverId: string, toolName: string): void {
    const state = this.getOrCreate(serverId, toolName);
    state.total_calls++;
    state.total_failures++;
    state.consecutive_successes = 0;

    if (state.status === 'half_open') {
      // Any failure in half_open immediately re-opens.
      state.status = 'open';
      state.opened_at = Date.now();
      logger.warn('breaker_reopened', { server_id: serverId, tool_name: toolName });
      return;
    }

    if (state.status === 'closed') {
      state.consecutive_failures++;
      if (state.consecutive_failures >= this.failureThreshold) {
        state.status = 'open';
        state.opened_at = Date.now();
        logger.warn('breaker_opened', {
          server_id: serverId,
          tool_name: toolName,
          consecutive_failures: state.consecutive_failures,
          cooldown_ms: this.cooldownMs,
        });
      }
    }
  }

  /**
   * Return a snapshot of every tracked tool's breaker state. Safe to call
   * from a `/metrics` endpoint or middleware.
   */
  getMetrics(): ToolCircuitBreakerMetrics[] {
    const out: ToolCircuitBreakerMetrics[] = [];
    for (const [key, state] of this.breakers) {
      const [server_id, tool_name] = key.split('::');
      out.push({ server_id, tool_name, ...state });
    }
    return out;
  }

  /** Force a single tool's breaker back to `closed` (testing / admin). */
  reset(serverId: string, toolName: string): void {
    this.breakers.delete(ToolCircuitBreakerManager.key(serverId, toolName));
  }

  private getOrCreate(serverId: string, toolName: string): ToolCircuitBreakerState {
    const key = ToolCircuitBreakerManager.key(serverId, toolName);
    let state = this.breakers.get(key);
    if (!state) {
      state = {
        status: 'closed',
        consecutive_failures: 0,
        consecutive_successes: 0,
        total_calls: 0,
        total_failures: 0,
        total_successes: 0,
      };
      this.breakers.set(key, state);
    }
    return state;
  }
}
