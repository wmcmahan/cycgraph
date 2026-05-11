/**
 * Persistence Coordinator
 *
 * Owns the runner's persistence pipeline: delta-vs-snapshot routing,
 * consecutive-failure tracking with the 3-strike halt rule, the
 * `state:persisted` stream event, and auto-compaction timing.
 *
 * ## Two distinct failure modes
 *
 * Persistence failures and compaction failures are treated very differently:
 *
 *   - **Persistence failure** → counted toward {@link MAX_PERSIST_FAILURES}.
 *     Three consecutive failures throw and halt the workflow. Reset to zero
 *     on the first success.
 *   - **Compaction failure** → logged at WARN and swallowed. The workflow
 *     keeps running because compaction is best-effort and re-runs naturally
 *     on the next interval tick.
 *
 * Mixing these would either halt a healthy workflow on a transient compaction
 * issue or silently lose state. The coordinator's tests pin this distinction.
 *
 * @module runner/persistence-coordinator
 */

import type { WorkflowState } from '../types/state.js';
import type { EventLogWriter } from '../db/event-log.js';
import type { StreamEvent } from './stream-events.js';
import type { StateDeltaTracker, StatePatch } from '../persistence/delta-tracker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.persistence-coordinator');

/** Halt threshold for consecutive persistence failures. */
export const MAX_PERSIST_FAILURES = 3;

/** Constructor dependencies. */
export interface PersistenceCoordinatorDeps {
  /** Full-snapshot persistence callback (from `GraphRunnerOptions.persistStateFn`). */
  persistStateFn?: (state: WorkflowState) => Promise<void>;
  /** Differential-persistence callback (from `GraphRunnerOptions.persistDeltaFn`). */
  persistDeltaFn?: (patch: StatePatch) => Promise<void>;
  /** Required when `persistDeltaFn` is set — computes delta vs full snapshot. */
  deltaTracker?: StateDeltaTracker;
  /** Event log writer (used by `compactNow` to write checkpoints). */
  eventLog: EventLogWriter;
  /**
   * Auto-compaction cadence. After this many `persist()` calls, the
   * coordinator triggers `compactNow()`. `0` disables auto-compaction.
   */
  compactionInterval: number;
  /**
   * Predicate the coordinator consults before pushing a `state:persisted`
   * event to the stream channel. Returns true when the runner is in
   * `stream()` mode.
   */
  isStreaming: () => boolean;
  /**
   * Push a stream event. Only called when `isStreaming()` returns true —
   * the coordinator does the gating, the runner provides the destination.
   */
  push: (event: StreamEvent) => void;
  /** EventEmitter passthrough — `runner.emit`. */
  emit: (event: 'state:persisted', payload: { run_id: string; iteration: number }) => void;
}

/**
 * Per-runner persistence pipeline. One instance per `GraphRunner` lifetime.
 */
export class PersistenceCoordinator {
  private persistFailures = 0;
  private eventsSinceLastCompaction = 0;

  constructor(private readonly deps: PersistenceCoordinatorDeps) {}

  /**
   * Persist the current state and (optionally) trigger auto-compaction.
   *
   * Effect order:
   *   1. Persist (delta or snapshot per `deltaTracker` presence).
   *   2. On success: reset failure counter, emit `state:persisted`, push to
   *      stream channel when streaming.
   *   3. On failure: increment counter; throw on the third strike.
   *   4. Increment auto-compaction counter; trigger compaction when it hits
   *      the interval. Compaction failures log WARN and do NOT increment the
   *      persist-failure counter.
   *
   * The auto-compaction step runs even when `persistStateFn` is unset — the
   * coordinator may still be wired to an event log that supports compaction.
   */
  async persist(state: WorkflowState, nextSequenceId: number): Promise<void> {
    if (this.deps.persistStateFn) {
      try {
        if (this.deps.deltaTracker && this.deps.persistDeltaFn) {
          const delta = this.deps.deltaTracker.computeDelta(state);
          if (delta.type === 'full') {
            await this.deps.persistStateFn(state);
          } else {
            await this.deps.persistDeltaFn(delta.patch);
          }
        } else {
          await this.deps.persistStateFn(state);
        }
        this.persistFailures = 0;

        this.deps.emit('state:persisted', {
          run_id: state.run_id,
          iteration: state.iteration_count,
        });

        if (this.deps.isStreaming()) {
          this.deps.push({
            type: 'state:persisted',
            run_id: state.run_id,
            iteration: state.iteration_count,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        this.persistFailures++;
        logger.error('state_persist_failed', error, {
          run_id: state.run_id,
          consecutive_failures: this.persistFailures,
        });

        if (this.persistFailures >= MAX_PERSIST_FAILURES) {
          throw new Error(
            `Persistence unavailable after ${this.persistFailures} consecutive failures. ` +
            `Halting workflow to prevent data loss.`,
          );
        }
      }
    }

    // Auto-compact — independent failure path (best-effort, swallowed).
    if (this.deps.compactionInterval > 0) {
      this.eventsSinceLastCompaction++;
      if (this.eventsSinceLastCompaction >= this.deps.compactionInterval) {
        try {
          const deleted = await this.compactNow(state, nextSequenceId);
          this.eventsSinceLastCompaction = 0;
          if (deleted > 0) {
            logger.info('auto_compaction', {
              run_id: state.run_id,
              events_deleted: deleted,
              interval: this.deps.compactionInterval,
            });
          }
        } catch (error) {
          // Auto-compaction is best-effort — don't halt the workflow and
          // crucially don't increment the persist-failure counter.
          logger.warn('auto_compaction_failed', {
            run_id: state.run_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Force a checkpoint + event-log compaction at the current sequenceId.
   * Used by both auto-compaction (inside `persist`) and the public
   * `GraphRunner.compactEvents()` method.
   *
   * @param state The state to embed in the checkpoint.
   * @param nextSequenceId The runner's `sequenceId` (next id to assign).
   *   Compaction deletes events at or before `nextSequenceId - 1`.
   * @returns Number of events deleted.
   */
  async compactNow(state: WorkflowState, nextSequenceId: number): Promise<number> {
    const seq = nextSequenceId - 1; // last appended id
    if (seq < 0) return 0;

    await this.deps.eventLog.checkpoint(state.run_id, seq, state);
    const deleted = await this.deps.eventLog.compact(state.run_id, seq);

    logger.info('events_compacted', {
      run_id: state.run_id,
      checkpoint_sequence_id: seq,
      events_deleted: deleted,
    });
    return deleted;
  }

  /** Current consecutive-failure count. For diagnostics. */
  get failureCount(): number {
    return this.persistFailures;
  }
}
