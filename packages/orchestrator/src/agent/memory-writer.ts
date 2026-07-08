/**
 * Memory Writer
 *
 * Optional function injected via GraphRunnerOptions to write facts
 * produced by reflection nodes into a long-lived memory store. Mirrors
 * the `MemoryRetriever` adapter pattern — the orchestrator defines the
 * type, the user provides the implementation (typically backed by an
 * `@cycgraph/memory` `MemoryStore`, optionally combined with a
 * `MemoryIndex` for embedding-based retrieval).
 *
 * @module agent/memory-writer
 */

/** A single fact emitted by a reflection node. */
export interface MemoryWriterFact {
  /** Atomic fact text — one sentence, present-tense, no pronouns. */
  content: string;
  /**
   * Tags applied to the fact. Used by retrieval queries to scope
   * lessons to a specific graph or domain (e.g. `['lesson', 'graph:x']`).
   */
  tags: string[];
  /**
   * Optional named entities the fact relates to. The writer is expected
   * to upsert these entities and link the fact to them in the knowledge
   * graph so the lesson is reachable by entity-driven retrieval.
   */
  entities?: Array<{ name: string; type: string }>;
  /**
   * Workflow context the fact was extracted from. Used for provenance
   * tracking so a future operator can trace a lesson back to its origin.
   */
  provenance: {
    workflow_id: string;
    run_id: string;
    graph_id: string;
    node_id: string;
    /** Source — `'agent'` for LLM-extracted, `'derived'` for rule-based. */
    source: 'agent' | 'derived';
  };
}

/** Result of a memory write call. */
export interface MemoryWriterResult {
  /** IDs of facts that were persisted. Length equals `facts.length` on success. */
  fact_ids: string[];
}

/**
 * Persist facts produced by a reflection node.
 *
 * Called by the reflection executor after extraction. The implementation
 * decides how to map facts into the underlying store (typically calls
 * `MemoryStore.createFact` per fact, optionally indexes embeddings).
 *
 * @param facts - Facts to persist.
 * @param options - Optional constraints.
 * @param options.idempotencyKey - Deduplication scope for this write,
 *   formatted `run_id:node_id:iteration`. The same key is passed again when
 *   the write repeats for the same node execution — after a node retry or
 *   crash recovery. Implementations SHOULD treat a repeated key as
 *   "already written" (skip or upsert) instead of inserting again,
 *   otherwise every retry permanently duplicates facts in long-term memory.
 * @param options.batchSize - Reserved for batch tuning.
 * @returns Result containing the IDs of the persisted facts.
 */
export type MemoryWriter = (
  facts: MemoryWriterFact[],
  options?: { batchSize?: number; idempotencyKey?: string },
) => Promise<MemoryWriterResult>;
