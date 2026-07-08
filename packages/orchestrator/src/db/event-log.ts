/**
 * Event Log Writer
 *
 * Abstraction layer between the {@link GraphRunner} and the event store.
 * Provides two built-in implementations:
 *
 *   - {@link NoopEventLogWriter}:    No-op for tests and lightweight deployments
 *   - {@link InMemoryEventLogWriter}: In-memory store for unit tests
 *
 * For production PostgreSQL, use `DrizzleEventLogWriter` from
 * `@cycgraph/orchestrator-postgres`.
 *
 * The GraphRunner accepts an optional `EventLogWriter`. If none is
 * provided, event sourcing is disabled (backward compatible).
 *
 * @module db/event-log
 */

import type { NewWorkflowEvent, WorkflowEvent } from '../types/event.js';
import type { WorkflowState } from '../types/state.js';
import { hydrateWorkflowState } from '../types/state.js';
import { CycgraphError } from '../errors.js';

/**
 * Thrown when an `append()` collides with an existing `(run_id, sequence_id)`.
 *
 * A sequence conflict means two writers are appending to the same run — a
 * split-brain that must surface loudly, never be silently absorbed. The
 * GraphRunner treats this as fatal for the local runner.
 */
export class EventSequenceConflictError extends CycgraphError {
  constructor(
    public readonly runId: string,
    public readonly sequenceId: number,
  ) {
    super(
      `Event sequence conflict for run ${runId} at sequence_id ${sequenceId}: ` +
      `another writer has already appended this event. ` +
      `This indicates two workers are executing the same run.`,
    );
    this.name = 'EventSequenceConflictError';
  }
}

/**
 * Interface for appending and reading workflow events.
 *
 * Implementations must guarantee:
 * - Events are stored durably (fsync or DB commit)
 * - `loadEvents()` returns events in `sequence_id` order
 * - `append()` REJECTS a duplicate `(run_id, sequence_id)` pair with
 *   {@link EventSequenceConflictError} — duplicates mean two writers are
 *   racing on one run and must never be silently dropped or double-stored
 */
export interface EventLogWriter {
  /**
   * Append a single event to the log.
   *
   * @throws {EventSequenceConflictError} If an event with the same
   *   `(run_id, sequence_id)` already exists.
   */
  append(event: NewWorkflowEvent): Promise<void>;

  /** Load all events for a run, ordered by `sequence_id` ascending. */
  loadEvents(run_id: string): Promise<WorkflowEvent[]>;

  /** Load events after a specific `sequence_id` (for checkpoint-accelerated recovery). */
  loadEventsAfter(run_id: string, afterSequenceId: number): Promise<WorkflowEvent[]>;

  /** Get the highest `sequence_id` for a run (`-1` if none). */
  getLatestSequenceId(run_id: string): Promise<number>;

  /** Save a checkpoint (state snapshot at a specific event `sequence_id`). */
  checkpoint(run_id: string, sequenceId: number, state: WorkflowState): Promise<void>;

  /** Load the latest checkpoint for a run (`null` if none). */
  loadCheckpoint(run_id: string): Promise<{ sequence_id: number; state: WorkflowState } | null>;

  /**
   * Compact the event log: delete events at or before `beforeSequenceId`.
   *
   * @returns Number of events deleted.
   */
  compact(run_id: string, beforeSequenceId: number): Promise<number>;
}

// ─── No-op Implementation ────────────────────────────────────────────

/**
 * No-op event log writer for tests and deployments that don't need durability.
 *
 * All writes are silently discarded. Reads return empty results.
 * This is the default when no `EventLogWriter` is provided to GraphRunner.
 */
export class NoopEventLogWriter implements EventLogWriter {
  async append(_event: NewWorkflowEvent): Promise<void> {
    // No-op
  }

  async loadEvents(_run_id: string): Promise<WorkflowEvent[]> {
    return [];
  }

  async loadEventsAfter(_run_id: string, _afterSequenceId: number): Promise<WorkflowEvent[]> {
    return [];
  }

  async getLatestSequenceId(_run_id: string): Promise<number> {
    return -1;
  }

  async checkpoint(_run_id: string, _sequenceId: number, _state: WorkflowState): Promise<void> {
    // No-op
  }

  async loadCheckpoint(_run_id: string): Promise<{ sequence_id: number; state: WorkflowState } | null> {
    return null;
  }

  async compact(_run_id: string, _beforeSequenceId: number): Promise<number> {
    return 0;
  }
}

// ─── In-Memory Implementation (for tests) ────────────────────────────

/**
 * In-memory event log writer for unit tests.
 *
 * Stores events in a `Map` keyed by `run_id`. Useful for testing event
 * append/replay without a database connection.
 *
 * Checkpoints are deep-cloned on both write and read to prevent
 * external mutation from affecting stored state.
 */
export class InMemoryEventLogWriter implements EventLogWriter {
  private readonly events = new Map<string, WorkflowEvent[]>();
  private readonly checkpoints = new Map<string, { sequence_id: number; state: WorkflowState }>();

  async append(event: NewWorkflowEvent): Promise<void> {
    const list = this.events.get(event.run_id) ?? [];
    if (list.some(e => e.sequence_id === event.sequence_id)) {
      throw new EventSequenceConflictError(event.run_id, event.sequence_id);
    }
    list.push({
      id: crypto.randomUUID(),
      ...event,
      created_at: new Date(),
    });
    this.events.set(event.run_id, list);
  }

  async loadEvents(run_id: string): Promise<WorkflowEvent[]> {
    const list = this.events.get(run_id) ?? [];
    return [...list].sort((a, b) => a.sequence_id - b.sequence_id);
  }

  async loadEventsAfter(run_id: string, afterSequenceId: number): Promise<WorkflowEvent[]> {
    const list = this.events.get(run_id) ?? [];
    return [...list]
      .filter(e => e.sequence_id > afterSequenceId)
      .sort((a, b) => a.sequence_id - b.sequence_id);
  }

  async getLatestSequenceId(run_id: string): Promise<number> {
    const list = this.events.get(run_id);
    if (!list || list.length === 0) return -1;
    return Math.max(...list.map(e => e.sequence_id));
  }

  async checkpoint(run_id: string, sequenceId: number, state: WorkflowState): Promise<void> {
    this.checkpoints.set(run_id, {
      sequence_id: sequenceId,
      state: JSON.parse(JSON.stringify(state)),
    });
  }

  async loadCheckpoint(run_id: string): Promise<{ sequence_id: number; state: WorkflowState } | null> {
    const cp = this.checkpoints.get(run_id);
    if (!cp) return null;
    // Deep clone so callers cannot mutate the stored checkpoint, then
    // hydrate: the JSON round-trip turned Dates into strings, exactly like
    // a jsonb column would. Hydrating here keeps in-memory behavior in
    // parity with the Postgres adapter.
    const clone = JSON.parse(JSON.stringify(cp)) as { sequence_id: number; state: unknown };
    return { sequence_id: clone.sequence_id, state: hydrateWorkflowState(clone.state) };
  }

  async compact(run_id: string, beforeSequenceId: number): Promise<number> {
    const list = this.events.get(run_id);
    if (!list) return 0;
    const before = list.length;
    const remaining = list.filter(e => e.sequence_id > beforeSequenceId);
    this.events.set(run_id, remaining);
    return before - remaining.length;
  }

  /** Get all events for inspection in tests. */
  getEventsForRun(run_id: string): WorkflowEvent[] {
    return this.events.get(run_id) ?? [];
  }

  /** Clear all stored events and checkpoints. */
  clear(): void {
    this.events.clear();
    this.checkpoints.clear();
  }
}
