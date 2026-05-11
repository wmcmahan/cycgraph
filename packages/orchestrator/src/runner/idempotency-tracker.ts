/**
 * Idempotency Tracker
 *
 * Tracks which `(nodeId, sequenceId)` action keys have already been applied
 * to a workflow run. Prevents duplicate reducer dispatches when a workflow
 * resumes from a checkpoint or replays from the event log.
 *
 * The tracker **does not own `sequenceId`** — sequence numbering is the
 * runner's responsibility (single-writer rule). This module only handles the
 * Set of executed keys plus the rebuild-from-event-log routine.
 *
 * @module runner/idempotency-tracker
 */

import type { EventLogWriter } from '../db/event-log.js';
import { EventLogCorruptionError } from './errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.idempotency-tracker');

/** Outcome of a rebuild attempt — gives the runner what it needs to set its sequenceId. */
export interface IdempotencyRebuildResult {
  /** How many keys were reconstructed (0 if no event log or no prior actions). */
  keysReconstructed: number;
  /**
   * Maximum sequence id observed across all events for this run. The runner
   * uses this to advance its `sequenceId` to `maxSequenceId + 1`. `null` when
   * no events were available — the runner keeps its current sequenceId.
   */
  maxSequenceId: number | null;
}

/**
 * Bounded Set of executed action keys. Keys are formatted as
 * `${nodeId}:${sequenceId}` and added in the runner's main loop just before
 * dispatch.
 */
export class IdempotencyTracker {
  private readonly executed = new Set<string>();

  /** Has the action for this `(node, sequence)` pair already been applied? */
  has(nodeId: string, sequenceId: number): boolean {
    return this.executed.has(`${nodeId}:${sequenceId}`);
  }

  /** Mark `(node, sequence)` as applied. Idempotent. */
  add(nodeId: string, sequenceId: number): void {
    this.executed.add(`${nodeId}:${sequenceId}`);
  }

  /** Current count — useful for diagnostics. */
  get size(): number {
    return this.executed.size;
  }

  /**
   * Rebuild the executed-keys Set from the event log when resuming a run.
   *
   * Prefers event-log data over heuristic state inspection — the event log
   * captures the exact `(nodeId, sequenceId)` keys the main loop used, which
   * correctly handles loops where the same node is visited multiple times.
   *
   * Throws {@link EventLogCorruptionError} when no events are loadable AND
   * the workflow has completed iterations — heuristic recovery is unsafe in
   * that case. Returns a "no rebuild needed" result when the workflow has
   * not yet iterated.
   */
  async rebuildFromEventLog(
    eventLog: EventLogWriter,
    runId: string,
    iterationCount: number,
  ): Promise<IdempotencyRebuildResult> {
    try {
      const events = await eventLog.loadEvents(runId);
      const actionEvents = events.filter(e => e.event_type === 'action_dispatched');

      if (actionEvents.length > 0) {
        for (const event of actionEvents) {
          const action = event.action as { metadata?: { node_id?: string } } | undefined;
          const actionNodeId = action?.metadata?.node_id ?? event.node_id;
          if (actionNodeId) {
            this.executed.add(`${actionNodeId}:${event.sequence_id}`);
          }
        }

        const maxSeq = events.length > 0
          ? events.reduce((max, e) => Math.max(max, e.sequence_id), 0)
          : null;

        logger.info('idempotency_reconstructed_from_events', {
          keys: this.executed.size,
          events_loaded: actionEvents.length,
        });
        return { keysReconstructed: this.executed.size, maxSequenceId: maxSeq };
      }
    } catch (error) {
      logger.warn('event_log_reconstruction_failed', {
        error: error instanceof Error ? error.message : String(error),
        hint: 'Falling back to corruption check',
      });
    }

    // No event log available. With completed iterations there's no safe
    // heuristic — refuse to silently proceed.
    if (iterationCount > 0) {
      throw new EventLogCorruptionError(runId);
    }
    logger.info('idempotency_no_prior_iterations', { run_id: runId });
    return { keysReconstructed: 0, maxSequenceId: null };
  }
}
