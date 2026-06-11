/**
 * Memory Retriever
 *
 * Optional function injected via GraphRunnerOptions to retrieve
 * relevant memory facts for prompt construction. Follows the same
 * adapter pattern as ContextCompressor — the orchestrator defines
 * the type, the user provides the implementation.
 *
 * @module agent/memory-retriever
 */

/** Result of a memory retrieval call. */
export interface MemoryRetrievalResult {
  /**
   * Relevant facts with their validity timestamps.
   *
   * `id` is optional but load-bearing for eval-gated learning: when
   * present it is recorded in the run's lesson provenance registry
   * (`memory._lesson_provenance`) so run outcomes can be attributed to
   * the facts that were injected. Adapters backed by `@cycgraph/memory`
   * should pass `SemanticFact.id` through — an adapter that strips ids
   * silently disables outcome attribution.
   */
  facts: Array<{ content: string; validFrom: Date; id?: string }>;
  /** Entities referenced by the facts. */
  entities: Array<{ name: string; type: string }>;
  /** High-level themes the facts belong to. */
  themes: Array<{ label: string }>;
}

/**
 * Retrieves relevant memory for injection into agent prompts.
 *
 * @param query - What to retrieve:
 *   - `text` — natural-language query for semantic search.
 *   - `entityIds` — seed IDs for knowledge-graph subgraph extraction.
 *   - `tags` — restrict matches to facts carrying at least one tag.
 *     Used by reflection consumers to scope retrieval to lessons from
 *     a specific graph or category.
 * @param options - Optional constraints.
 * @returns Retrieved memory, or null to skip injection.
 */
export type MemoryRetriever = (
  query: { text?: string; entityIds?: string[]; tags?: string[] },
  options?: { maxFacts?: number; model?: string },
) => Promise<MemoryRetrievalResult | null>;
