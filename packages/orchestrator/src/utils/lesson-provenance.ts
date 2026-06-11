/**
 * Lesson Provenance Utilities
 *
 * Manages the lesson provenance registry stored at
 * `memory._lesson_provenance`: one entry per retrieval event, recording
 * which memory facts were injected into which node's prompt. After the
 * run, `getInjectedFactIds(finalState)` yields the fact IDs to feed an
 * outcome ledger (`@cycgraph/memory`'s eval-gated retention).
 *
 * Entries are minted inside `update_memory` action payloads at
 * execution time (like `TaintMetadata.created_at`), so event-log replay
 * reproduces them verbatim. The reducer merges registries append-only
 * and applies `trimLessonProvenance` — both pure and deterministic.
 *
 * The `_` prefix keeps the registry out of every node's StateView and
 * exempts it from write-permission validation, mirroring
 * `_taint_registry`.
 *
 * @module utils/lesson-provenance
 */

import type {
  LessonProvenanceEntry,
  LessonProvenanceRegistry,
  WorkflowState,
} from '../types/state.js';

/** Well-known memory key for the lesson provenance registry. */
export const LESSON_PROVENANCE_KEY = '_lesson_provenance';

/**
 * Ring-buffer cap on registry entries (newest kept). One entry is
 * written per node execution that injected retrieved facts, so 256
 * covers any realistic run length while bounding state size.
 *
 * REPLAY WARNING: this constant participates in the reducer's trim and
 * therefore in event-log replay of new logs. Changing it (or the trim
 * ordering in `trimLessonProvenance`) changes replayed state — bump
 * `REPLAY_VERSION` in `reducers/index.ts` if you ever do.
 */
export const MAX_LESSON_PROVENANCE_ENTRIES = 256;

/**
 * Get the lesson provenance registry from a memory object.
 * Returns an empty object when absent or malformed.
 */
export function getLessonProvenanceRegistry(
  memory: Record<string, unknown>,
): LessonProvenanceRegistry {
  const raw = memory[LESSON_PROVENANCE_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as LessonProvenanceRegistry;
  }
  return {};
}

/** Total order: `retrieved_at` then entry key — stable across replays. */
function compareEntries(
  [keyA, a]: [string, LessonProvenanceEntry],
  [keyB, b]: [string, LessonProvenanceEntry],
): number {
  const delta = a.retrieved_at.localeCompare(b.retrieved_at);
  return delta !== 0 ? delta : keyA.localeCompare(keyB);
}

/**
 * All provenance entries for a run, oldest first (deterministic order).
 */
export function getLessonProvenance(state: WorkflowState): LessonProvenanceEntry[] {
  return Object.entries(getLessonProvenanceRegistry(state.memory))
    .sort(compareEntries)
    .map(([, entry]) => entry);
}

/**
 * The deduplicated set of fact IDs injected into prompts during a run —
 * the value to pass as `fact_ids` when recording the run's outcome.
 * Order is deterministic (first occurrence in entry order).
 */
export function getInjectedFactIds(state: WorkflowState): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of getLessonProvenance(state)) {
    for (const id of entry.fact_ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Keep the newest `MAX_LESSON_PROVENANCE_ENTRIES` entries. Pure and
 * fully deterministic (see total order above) — safe inside reducers.
 * Returns the input object unchanged when under the cap.
 */
export function trimLessonProvenance(
  registry: LessonProvenanceRegistry,
): LessonProvenanceRegistry {
  const entries = Object.entries(registry);
  if (entries.length <= MAX_LESSON_PROVENANCE_ENTRIES) return registry;

  entries.sort(compareEntries);
  const kept = entries.slice(entries.length - MAX_LESSON_PROVENANCE_ENTRIES);
  return Object.fromEntries(kept);
}
