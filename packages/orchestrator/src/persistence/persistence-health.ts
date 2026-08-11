/**
 * Persistence Health Tracking
 *
 * Monitors consecutive persistence failures and halts the workflow
 * if a configurable threshold is breached, preventing silent data loss.
 *
 * DB-agnostic — works with any {@link PersistenceProvider}.
 *
 * @module persistence/persistence-health
 */

import type { PersistenceProvider } from './interfaces.js';
import type { WorkflowState } from '../state/state.js';
import { createLogger } from '../observability/logger.js';
import { CycgraphError } from '../errors.js';

const logger = createLogger('db.persistence');

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Number of consecutive persistence failures before the workflow is
 * halted to prevent data loss. Overridable via the
 * `MAX_PERSISTENCE_FAILURES` environment variable.
 */
const MAX_CONSECUTIVE_FAILURES =
  parseInt(process.env.MAX_PERSISTENCE_FAILURES ?? '', 10) || 3;

// ─── Health Metrics ─────────────────────────────────────────────────

/** Snapshot of persistence subsystem health metrics. */
export interface PersistenceHealth {
  /** Number of failures since the last successful persist. */
  consecutiveFailures: number;
  /** Timestamp of the most recent successful persist (`null` if never). */
  lastSuccessAt: Date | null;
  /** Timestamp of the most recent failed persist (`null` if never). */
  lastFailureAt: Date | null;
  /** Lifetime failure count. */
  totalFailures: number;
  /** Lifetime success count. */
  totalSuccesses: number;
}

const health: PersistenceHealth = {
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  totalFailures: 0,
  totalSuccesses: 0,
};

/**
 * Return a frozen copy of the current health metrics.
 *
 * @returns A readonly snapshot — mutations do not affect internal state.
 */
export function getPersistenceHealth(): Readonly<PersistenceHealth> {
  return { ...health };
}

/**
 * Reset all health metrics to their initial state.
 *
 * Intended for use in tests and when re-initializing the persistence layer.
 */
export function resetPersistenceHealth(): void {
  health.consecutiveFailures = 0;
  health.lastSuccessAt = null;
  health.lastFailureAt = null;
  health.totalFailures = 0;
  health.totalSuccesses = 0;
}

// ─── Persist with Health Tracking ───────────────────────────────────

/**
 * Persist both the workflow run record and state snapshot, tracking
 * consecutive failures.
 *
 * On success the failure counter is reset. On failure:
 * - The counter is incremented and the error is logged.
 * - If the counter reaches {@link MAX_CONSECUTIVE_FAILURES}, a
 *   {@link PersistenceUnavailableError} is thrown to halt the workflow
 *   and prevent data loss.
 * - Otherwise a degraded-mode warning is logged and execution continues.
 *
 * @param state - The current workflow state to persist.
 * @param provider - The persistence backend.
 * @throws {PersistenceUnavailableError} After the configured failure threshold.
 */
export async function persistWorkflow(
  state: WorkflowState,
  provider: PersistenceProvider,
): Promise<void> {
  try {
    // Prefer atomic snapshot if available, fall back to parallel save
    if (provider.saveWorkflowSnapshot) {
      await provider.saveWorkflowSnapshot(state);
    } else {
      await Promise.all([
        provider.saveWorkflowRun(state),
        provider.saveWorkflowState(state),
      ]);
    }

    health.consecutiveFailures = 0;
    health.lastSuccessAt = new Date();
    health.totalSuccesses++;

    logger.debug('state_persisted', {
      run_id: state.run_id,
      status: state.status,
      iteration: state.iteration_count,
    });
  } catch (error) {
    health.consecutiveFailures++;
    health.lastFailureAt = new Date();
    health.totalFailures++;

    logger.error('persistence_failed', error, {
      run_id: state.run_id,
      consecutive_failures: health.consecutiveFailures,
      total_failures: health.totalFailures,
    });

    if (health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new PersistenceUnavailableError(
        `Database persistence unavailable after ${health.consecutiveFailures} consecutive failures. ` +
        `Last success: ${health.lastSuccessAt?.toISOString() || 'never'}. ` +
        `Halting workflow to prevent data loss.`
      );
    }

    logger.warn('persistence_degraded', {
      consecutive_failures: health.consecutiveFailures,
      max_before_halt: MAX_CONSECUTIVE_FAILURES,
    });
  }
}

// ─── Error Class ────────────────────────────────────────────────────

/**
 * Thrown when the persistence layer has exceeded the consecutive
 * failure threshold and is considered unavailable.
 *
 * The workflow must be halted to prevent silent data loss.
 *
 * @example
 * ```ts
 * throw new PersistenceUnavailableError('DB unreachable after 3 failures');
 * ```
 */
export class PersistenceUnavailableError extends CycgraphError {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

