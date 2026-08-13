/**
 * Idempotency Tracker
 *
 * Tracks which `(nodeId, iteration)` actions have already been applied to a
 * run, so a resumed run never re-executes a node whose action was reduced
 * into state before a crash.
 *
 * Keys are `${nodeId}:${iteration}`, where `iteration` is
 * `state.iteration_count` at the moment the node executed (pre-increment).
 * The main loop, event-log replay, and snapshot resume all produce them.
 *
 * The crash window: per step the runner appends `action_dispatched`,
 * reduces, persists a snapshot, then `_increment_iteration`, `_advance`,
 * and persists again. A crash between the first persist and `_advance`
 * leaves a snapshot that already contains the action's effects while
 * `current_node` still points at the node that produced it, and resuming it
 * must not re-execute that node. Whether an action's effects are inside a
 * snapshot is decided by the snapshot's `_last_event_sequence_id`
 * high-water mark: events at or below it were durable before the snapshot
 * committed.
 *
 * Sequence numbering belongs to the runner (single-writer rule), not here.
 *
 * @module execution/coordination/idempotency-tracker
 */

import type { EventLogWriter } from '../../persistence/event-log.js';
import { createLogger } from '../../observability/logger.js';

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

/** The slice of resumed state the rebuild needs for crash-window detection. */
export interface ResumedStateInfo {
  current_node?: string;
  iteration_count: number;
  /** Event-log high-water mark stamped into the snapshot at persist time. */
  _last_event_sequence_id?: number;
}

/**
 * Bounded Set of executed action keys, formatted `${nodeId}:${iteration}`.
 */
export class IdempotencyTracker {
  private readonly executed = new Set<string>();

  /** Has the action for this `(node, iteration)` pair already been applied? */
  has(nodeId: string, iteration: number): boolean {
    return this.executed.has(`${nodeId}:${iteration}`);
  }

  /** Mark `(node, iteration)` as applied. Idempotent. */
  add(nodeId: string, iteration: number): void {
    this.executed.add(`${nodeId}:${iteration}`);
  }

  /** Current count — useful for diagnostics. */
  get size(): number {
    return this.executed.size;
  }

  /**
   * Rebuild duplicate-detection state from the event log when resuming a
   * run from a snapshot (NOT the full-replay `recover()` path, which adds
   * its keys via `_rehydrate`).
   *
   * Returns the max sequence id so the runner can continue numbering, and —
   * when the snapshot's high-water mark proves the crash happened after the
   * current node's action was reduced but before `_advance` — marks the
   * `(current_node, iteration_count)` pair as already applied.
   *
   * Snapshots without a `_last_event_sequence_id` (pre-versioning, or
   * hand-constructed) get NO markers: the current node re-executes
   * (at-least-once), which is the safe direction — skipping a node whose
   * effects are absent from the snapshot would lose a state transition.
   */
  async rebuildFromEventLog(
    eventLog: EventLogWriter,
    runId: string,
    resumedState: ResumedStateInfo,
  ): Promise<IdempotencyRebuildResult> {
    // Compaction deletes events behind the checkpoint, so the tail after it
    // is information-equivalent to the full history. No checkpoint: full load.
    let events;
    let baseSequenceId = 0;
    try {
      const checkpoint = await eventLog.loadCheckpoint(runId);
      if (checkpoint) {
        baseSequenceId = checkpoint.sequence_id;
        events = await eventLog.loadEventsAfter(runId, checkpoint.sequence_id);
      } else {
        events = await eventLog.loadEvents(runId);
      }
    } catch (error) {
      logger.warn('event_log_load_failed_on_resume', {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
        hint: 'Resuming without duplicate detection — current node re-executes (at-least-once)',
      });
      return { keysReconstructed: 0, maxSequenceId: null };
    }

    if (events.length === 0) {
      // No events past the checkpoint. If a checkpoint exists, numbering must
      // continue above its sequence id; otherwise this is a snapshot-only /
      // Noop-writer resume (at-least-once semantics).
      if (resumedState.iteration_count > 0 && baseSequenceId === 0) {
        logger.warn('resume_without_event_log', {
          run_id: runId,
          iteration: resumedState.iteration_count,
          hint: 'No events available — current node may re-execute (at-least-once)',
        });
      }
      return { keysReconstructed: 0, maxSequenceId: baseSequenceId > 0 ? baseSequenceId : null };
    }

    const maxSeq = events.reduce((max, e) => Math.max(max, e.sequence_id), baseSequenceId);

    // Crash-window detection: find the last action_dispatched whose effects
    // are provably inside the snapshot (sequence_id <= high-water mark) and
    // check whether an _advance follows it within the same durable range.
    const highWater = resumedState._last_event_sequence_id;
    if (highWater !== undefined && resumedState.current_node) {
      let lastActionNode: string | undefined;
      let advanceAfterLastAction = false;
      for (const event of events) {
        if (event.sequence_id > highWater) break;
        if (event.event_type === 'action_dispatched') {
          lastActionNode = event.action?.metadata?.node_id ?? event.node_id;
          advanceAfterLastAction = false;
        } else if (
          event.event_type === 'internal_dispatched' &&
          (event.internal_type === '_advance' || event.internal_type === '_increment_iteration')
        ) {
          advanceAfterLastAction = true;
        }
      }

      if (lastActionNode === resumedState.current_node && !advanceAfterLastAction) {
        this.add(resumedState.current_node, resumedState.iteration_count);
        logger.info('idempotency_marked_applied_action', {
          run_id: runId,
          node_id: resumedState.current_node,
          iteration: resumedState.iteration_count,
        });
      }
    }

    logger.info('idempotency_rebuilt_from_events', {
      run_id: runId,
      keys: this.executed.size,
      max_sequence_id: maxSeq,
    });
    return { keysReconstructed: this.executed.size, maxSequenceId: maxSeq };
  }
}
