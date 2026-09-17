/**
 * State Delta Tracker
 *
 * Tracks changes between workflow state snapshots to enable
 * differential persistence. Instead of serializing the entire
 * `WorkflowState` on every persist, only the changed portions
 * are computed and stored.
 *
 * Usage:
 * ```ts
 * const tracker = new StateDeltaTracker({ fullSnapshotInterval: 10 });
 *
 * // In the persist path:
 * const delta = tracker.computeDelta(currentState);
 * if (delta.type === 'full') {
 *   await saveFullSnapshot(delta.state);
 * } else {
 *   await saveDelta(delta.patch);
 * }
 * ```
 *
 * @module persistence/delta-tracker
 */

import { WorkflowStateSchema, type WorkflowState } from '../state/state.js';

/**
 * A JSON-serializable patch representing changes to workflow state.
 */
export interface StatePatch {
  /** Run ID this patch applies to. */
  run_id: string;
  /** Version this patch produces (auto-incremented). */
  version: number;
  /** Changed scalar fields (status, current_node, iteration_count, etc.). */
  fields: Record<string, unknown>;
  /** Memory keys that were added or updated (with new values). */
  memory_updates: Record<string, unknown>;
  /** Memory keys that were removed. */
  memory_removals: string[];
}

/**
 * Result of delta computation — either a full snapshot or a patch.
 */
export type DeltaResult =
  | { type: 'full'; state: WorkflowState }
  | { type: 'patch'; patch: StatePatch };

/**
 * Options for the StateDeltaTracker.
 */
export interface StateDeltaTrackerOptions {
  /**
   * Number of persists between forced full snapshots.
   * Full snapshots ensure recovery doesn't require replaying
   * a long chain of patches. @default 10
   */
  fullSnapshotInterval?: number;
  /**
   * Maximum patch size in bytes (estimated). If a patch exceeds
   * this, a full snapshot is emitted instead. @default 50000
   */
  maxPatchBytes?: number;
}

/**
 * Top-level WorkflowState keys the patch diffs: every schema key except
 * `memory`, which gets keyed updates/removals of its own. Derived from
 * the schema so a field added to WorkflowState is tracked the moment it
 * exists — a hand-maintained list silently dropped every field the
 * v1→v2 migration lifted out of `memory` (taint registry, lesson
 * provenance, HITL approvals, subgraph checkpoints, the event-log
 * high-water mark), and a patch-resumed run then lost security and
 * crash-recovery state. An unchanged field never enters a patch, so
 * tracking everything costs bytes only when something actually moved.
 * Exported for the drift test that pins this derivation.
 */
export const TRACKED_FIELDS = Object.freeze(
  Object.keys(WorkflowStateSchema.shape).filter((key) => key !== 'memory'),
) as readonly (keyof WorkflowState)[];

/**
 * Tracks state changes and computes deltas for differential persistence.
 */
export class StateDeltaTracker {
  private lastState: WorkflowState | null = null;
  private persistCount: number = 0;
  // One-level undo stash for the most recent computeDelta (see rollback()).
  private prevState: WorkflowState | null = null;
  private prevPersistCount: number = 0;
  private readonly fullSnapshotInterval: number;
  private readonly maxPatchBytes: number;

  constructor(options?: StateDeltaTrackerOptions) {
    this.fullSnapshotInterval = options?.fullSnapshotInterval ?? 10;
    this.maxPatchBytes = options?.maxPatchBytes ?? 50_000;
  }

  /**
   * Compute a delta between the last-persisted state and the current state,
   * advancing the baseline to `state`.
   *
   * The previous baseline is stashed so a failed persist can be undone via
   * {@link rollback}: if the caller's write throws, it rolls back and the next
   * `computeDelta` re-diffs against the last *durably persisted* state, so the
   * failed iteration's changes are re-included rather than silently lost.
   *
   * Returns a full snapshot when:
   * - This is the first persist (no previous state)
   * - The full snapshot interval has elapsed
   * - The computed patch exceeds the max size threshold
   *
   * Otherwise returns a compact patch with only changed fields and memory keys.
   */
  computeDelta(state: WorkflowState): DeltaResult {
    // Stash the pre-advance baseline so rollback() can undo this on a failed
    // persist. Single-level: the coordinator always persists (and possibly
    // rolls back) before the next computeDelta.
    this.prevState = this.lastState;
    this.prevPersistCount = this.persistCount;

    this.persistCount++;

    // Force full snapshot on first persist or at interval
    if (!this.lastState || this.persistCount % this.fullSnapshotInterval === 0) {
      this.lastState = this.cloneState(state);
      return { type: 'full', state };
    }

    const patch = this.buildPatch(this.lastState, state, this.persistCount);

    // Check patch size — fall back to full snapshot if too large
    const estimatedSize = JSON.stringify(patch).length;
    if (estimatedSize > this.maxPatchBytes) {
      this.lastState = this.cloneState(state);
      return { type: 'full', state };
    }

    this.lastState = this.cloneState(state);
    return { type: 'patch', patch };
  }

  /**
   * Undo the baseline advance from the most recent {@link computeDelta}. Call
   * this when the persist that consumed that delta failed, so the next delta
   * diffs against the last successfully persisted state (no lost patches, no
   * skipped version numbers).
   */
  rollback(): void {
    this.lastState = this.prevState;
    this.persistCount = this.prevPersistCount;
  }

  /**
   * Build a patch from two state snapshots. `version` is the persist count
   * this patch will carry once committed.
   */
  private buildPatch(prev: WorkflowState, curr: WorkflowState, version: number): StatePatch {
    const fields: Record<string, unknown> = {};

    // Diff scalar fields (use string comparison for Date-typed fields)
    for (const field of TRACKED_FIELDS) {
      const prevVal = prev[field];
      const currVal = curr[field];
      if (!this.valuesEqual(prevVal, currVal)) {
        fields[field] = currVal;
      }
    }

    // Diff memory
    const memoryUpdates: Record<string, unknown> = {};
    const memoryRemovals: string[] = [];

    const prevMemory = prev.memory;
    const currMemory = curr.memory;
    const prevKeys = new Set(Object.keys(prevMemory));
    const currKeys = new Set(Object.keys(currMemory));

    for (const key of currKeys) {
      // Deep-compare like the tracked fields: the baseline is a JSON
      // clone, so reference equality never holds and a `!==` check
      // re-serializes every object-valued key into every patch.
      if (!prevKeys.has(key) || !this.valuesEqual(prevMemory[key], currMemory[key])) {
        memoryUpdates[key] = currMemory[key];
      }
    }

    for (const key of prevKeys) {
      if (!currKeys.has(key)) {
        memoryRemovals.push(key);
      }
    }

    return {
      run_id: curr.run_id,
      version,
      fields,
      memory_updates: memoryUpdates,
      memory_removals: memoryRemovals,
    };
  }

  /**
   * Compare two values for equality, handling Date objects.
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    // Handle JSON-cloned dates (string) vs original Date
    if (a instanceof Date || b instanceof Date) {
      const aStr = a instanceof Date ? a.toISOString() : String(a);
      const bStr = b instanceof Date ? b.toISOString() : String(b);
      return aStr === bStr;
    }
    // Deep-compare object-valued tracked fields (e.g. model_breakdown) so an
    // unchanged map doesn't register as a diff — and re-persist — every version.
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Deep clone state via JSON round-trip (prevents reference sharing).
   */
  private cloneState(state: WorkflowState): WorkflowState {
    return JSON.parse(JSON.stringify(state));
  }

  /**
   * Reset tracker state (e.g., when starting a new run).
   */
  reset(): void {
    this.lastState = null;
    this.persistCount = 0;
    this.prevState = null;
    this.prevPersistCount = 0;
  }

  /** Number of persists since creation or last reset. */
  getPersistCount(): number {
    return this.persistCount;
  }
}
