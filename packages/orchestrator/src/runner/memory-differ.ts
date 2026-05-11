/**
 * Memory Differ
 *
 * Pure utility for computing the delta between two `WorkflowState.memory`
 * snapshots. Used by the runner after every reducer apply to populate the
 * `action:applied` event's `memory_diff` field.
 *
 * Pure function — no side effects, no state. Stable across snapshots that
 * are referentially equal.
 *
 * @module runner/memory-differ
 */

import type { MemoryDiff } from './stream-events.js';

/**
 * Compute the diff between two memory snapshots.
 *
 * Comparison is shallow (`!==`) — nested mutations on a referentially-equal
 * object are NOT detected. The orchestrator's reducers always produce new
 * object references on change, so this is safe in practice.
 *
 * @returns `undefined` when nothing changed (caller can skip the event).
 */
export function computeMemoryDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): MemoryDiff | undefined {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const values: Record<string, unknown> = {};

  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) {
      added.push(key);
      values[key] = after[key];
    } else if (before[key] !== after[key]) {
      changed.push(key);
      values[key] = after[key];
    }
  }

  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      removed.push(key);
    }
  }

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return undefined;
  }

  return { added, changed, removed, values };
}
