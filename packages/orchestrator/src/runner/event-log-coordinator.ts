/**
 * Event Log Coordinator
 *
 * Owns the runner's durable event-log pipeline: sequence-id assignment
 * (single writer), fire-and-forget appends with a flush barrier,
 * consecutive-failure tracking with the 3-strike halt rule, the fatal
 * split-brain latch, and deferred appends for pre-run dispatches.
 *
 * ## Failure semantics
 *
 *   - **Append failure** → recorded per-append; surfaced at the next
 *     `flush()`. Three consecutive flushes containing failures throw and
 *     halt the workflow (same rule as snapshot persistence in
 *     {@link PersistenceCoordinator}).
 *   - **Sequence conflict / stale claim** → another writer owns this run.
 *     Latched as fatal on the append and re-thrown by the next `flush()`
 *     regardless of the consecutive-failure budget.
 *
 * ## Deferred appends
 *
 * Events recorded before `sequenceId` is known to be past the run's
 * existing log (e.g. `applyHumanResponse()` runs before `run()` on
 * resume, when a fresh runner still has sequenceId 0) would collide with
 * existing events. `withDeferredAppends()` buffers them;
 * `replayDeferred()` re-appends them once the resume path has advanced
 * the sequence via `advanceSequenceTo()`.
 *
 * @module runner/event-log-coordinator
 */

import type { Action } from '../types/state.js';
import type { EventType } from '../types/event.js';
import type { EventLogWriter } from '../db/event-log.js';
import { EventSequenceConflictError } from '../db/event-log.js';
import { StaleClaimError } from '../persistence/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.event-log-coordinator');

/** Halt threshold for consecutive event-log flush failures. */
export const MAX_EVENT_LOG_FAILURES = 3;

/** Per-event options accepted by {@link EventLogCoordinator.append}. */
export interface AppendEventOptions {
  node_id?: string;
  action?: Action;
  internal_type?: string;
  internal_payload?: Record<string, unknown>;
}

/** Constructor dependencies. */
export interface EventLogCoordinatorDeps {
  /** The durable event log writer. */
  eventLog: EventLogWriter;
  /** Live run-id accessor — the runner's state object is reassigned per reduce. */
  getRunId: () => string;
}

/**
 * Per-runner event-log pipeline. One instance per `GraphRunner` lifetime.
 */
export class EventLogCoordinator {
  /** Next sequence id to assign. The coordinator is the single writer. */
  private sequenceId = 0;

  /** Consecutive flushes that contained at least one failed append. */
  private flushFailures = 0;

  // Append promises issued since the last flush. Appends overlap with node
  // execution (no per-event latency), but the flush barrier awaits them all
  // BEFORE the state snapshot commits, so the event log can never silently
  // fall behind the snapshot it anchors.
  private pendingAppends: Array<Promise<{ ok: boolean }>> = [];

  // A fatal append error observed on any append: a sequence conflict or a
  // stale claim both mean another writer is executing this run — fatal for
  // this runner regardless of the consecutive-failure budget.
  private fatalError: Error | null = null;

  private deferAppends = false;
  private deferredEvents: Array<{ event_type: EventType; opts: AppendEventOptions }> = [];

  constructor(private readonly deps: EventLogCoordinatorDeps) {}

  /** The next sequence id the coordinator would assign. */
  get nextSequenceId(): number {
    return this.sequenceId;
  }

  /** The last sequence id already assigned (`-1` before the first append). */
  get lastAssignedSequenceId(): number {
    return this.sequenceId - 1;
  }

  /**
   * Advance the sequence counter to at least `nextId`. Used on resume
   * (after rebuilding from the existing log) and on recovery rehydrate so
   * new appends never collide with events already in the log. Never moves
   * the counter backwards.
   */
  advanceSequenceTo(nextId: number): void {
    if (nextId > this.sequenceId) {
      this.sequenceId = nextId;
    }
  }

  /**
   * Append an event to the durable event log.
   *
   * The write starts immediately but is not awaited here — `flush()`
   * (called from the runner's `persistState()`) awaits every outstanding
   * append before the state snapshot commits. Failures are tracked there;
   * sequence conflicts are remembered and re-thrown as fatal.
   */
  append(event_type: EventType, opts: AppendEventOptions = {}): void {
    if (this.deferAppends) {
      this.deferredEvents.push({ event_type, opts });
      return;
    }
    const event = {
      run_id: this.deps.getRunId(),
      sequence_id: this.sequenceId++,
      event_type,
      ...opts,
    };
    const promise = this.deps.eventLog.append(event).then(
      () => ({ ok: true }),
      (error) => {
        if (error instanceof EventSequenceConflictError || error instanceof StaleClaimError) {
          this.fatalError = error;
        }
        logger.error('event_log_append_failed', error, {
          run_id: event.run_id,
          sequence_id: event.sequence_id,
          event_type,
        });
        return { ok: false };
      },
    );
    this.pendingAppends.push(promise);
  }

  /**
   * Await all outstanding appends.
   *
   * A write barrier: events must be durable before the snapshot that
   * reflects them. Without this barrier a crash could leave a snapshot
   * whose history is missing from the log, and event-log recovery would
   * silently reconstruct an older state.
   *
   * @throws {EventSequenceConflictError} If any append collided with an
   *   existing sequence_id — another writer owns this run.
   * @throws {Error} After {@link MAX_EVENT_LOG_FAILURES} consecutive
   *   flushes containing failures (same rule as snapshot persistence).
   */
  async flush(): Promise<void> {
    if (this.pendingAppends.length === 0) return;
    const pending = this.pendingAppends;
    this.pendingAppends = [];
    const results = await Promise.all(pending);

    if (this.fatalError) {
      throw this.fatalError;
    }

    const failed = results.filter(r => !r.ok).length;
    if (failed > 0) {
      this.flushFailures++;
      logger.error('event_log_flush_failed', new Error(`${failed} append(s) failed`), {
        run_id: this.deps.getRunId(),
        consecutive_failed_flushes: this.flushFailures,
      });
      if (this.flushFailures >= MAX_EVENT_LOG_FAILURES) {
        throw new Error(
          `Event log unavailable after ${this.flushFailures} consecutive failed flushes. ` +
          `Halting workflow to prevent unrecoverable event-log divergence.`,
        );
      }
    } else {
      this.flushFailures = 0;
    }
  }

  /**
   * Buffer any appends issued while `fn` runs instead of assigning them
   * sequence ids. Used for dispatches that happen before execution starts
   * (see module doc). Pair with {@link replayDeferred} once the sequence
   * counter is safe.
   */
  withDeferredAppends<T>(fn: () => T): T {
    this.deferAppends = true;
    try {
      return fn();
    } finally {
      this.deferAppends = false;
    }
  }

  /** Re-append events buffered by {@link withDeferredAppends}, in order. */
  replayDeferred(): void {
    if (this.deferredEvents.length === 0) return;
    const deferred = this.deferredEvents;
    this.deferredEvents = [];
    for (const { event_type, opts } of deferred) {
      this.append(event_type, opts);
    }
  }
}
