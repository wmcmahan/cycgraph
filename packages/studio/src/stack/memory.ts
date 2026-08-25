/**
 * Memory adapters
 *
 * A `MemoryRetriever` and `MemoryWriter` over whichever store the stack
 * resolved, plus the outcome ledger the eval gate accrues evidence in.
 *
 * Two things here are load-bearing and both are documented traps:
 *
 * - The retriever passes fact `id` through. Without it the runner records
 *   nothing in `lesson_provenance` and eval-gated learning silently degrades
 *   to keep-everything.
 * - The writer gates through `checkFactAdmission` rather than exact-match
 *   dedup. LLM reflection re-emits the same lesson reworded, so exact matching
 *   lets the pool bloat until trial slots starve, and lets a paraphrase of an
 *   evicted lesson back in under a fresh id.
 *
 * @module stack/memory
 */

import { checkFactAdmission, retrieveMemory } from '@cycgraph/memory';
import type {
  MemoryIndex,
  MemoryStore,
  OutcomeLedger,
  Provenance,
  SemanticFact,
} from '@cycgraph/memory';
import type { MemoryRetriever, MemoryWriter } from '@cycgraph/orchestrator';

/**
 * A writer and retriever bound to one namespace, named as the runner options
 * expect so a scenario can spread them straight into `runner`.
 */
export interface MemoryNamespace {
  memoryWriter: MemoryWriter;
  memoryRetriever: MemoryRetriever;
}

/** What a scenario gets when the `memory` feature is available. */
export interface MemoryStack {
  store: MemoryStore;
  index: MemoryIndex;
  ledger: OutcomeLedger;
  /**
   * Bind a writer and retriever to `tag`.
   *
   * Scenarios take their own namespace so one cannot read or dedup against
   * another's facts. Sharing a namespace across scenarios would be
   * indistinguishable from a scenario mis-tagging its own writes.
   */
  namespace(tag: string): MemoryNamespace;
}

/** Build the namespace factory over a resolved store. */
export function createMemoryStack(
  store: MemoryStore,
  index: MemoryIndex,
  ledger: OutcomeLedger,
): MemoryStack {
  const namespace = (tag: string): MemoryNamespace => {
    const writer: MemoryWriter = async (facts) => {
      const now = new Date();
      const ids: string[] = [];

      for (const fact of facts) {
        // Scoped to the namespace alone, never the fact's full tag list. Tags
        // match on any, so including a shared marker like `lesson` would widen
        // the candidate set to every namespace using it and suppress writes
        // that are new here.
        const verdict = await checkFactAdmission(store, { content: fact.content }, { tags: [tag] });
        if (!verdict.admit) continue;

        const provenance: Provenance = {
          source: fact.provenance.source,
          created_at: now,
          run_id: fact.provenance.run_id,
          node_id: fact.provenance.node_id,
        };
        const stored: SemanticFact = {
          id: crypto.randomUUID(),
          content: fact.content,
          source_episode_ids: [],
          entity_ids: [],
          provenance,
          valid_from: now,
          // Stamped so the namespace scope above can find it again, whatever
          // else the node tagged it with.
          tags: fact.tags.includes(tag) ? fact.tags : [...fact.tags, tag],
        };
        await store.putFact(stored);
        ids.push(stored.id);
      }

      return { fact_ids: ids };
    };

    const retriever: MemoryRetriever = async (query, options) => {
      const result = await retrieveMemory(store, index, {
        tags: query.tags ?? [tag],
        maxHops: 0,
        limit: options?.maxFacts ?? 20,
        minSimilarity: 0,
        includeInvalidated: false,
      });

      return {
        // `id` passthrough feeds `state.lesson_provenance`. Dropping it is the
        // documented way to silently break eval-gated learning.
        facts: result.facts.map((f) => ({
          content: f.content,
          validFrom: f.valid_from,
          id: f.id,
          // Present only on the ranking paths; the tag path selects.
          ...(result.scores?.[f.id] !== undefined ? { score: result.scores[f.id] } : {}),
        })),
        entities: result.entities.map((e) => ({ name: e.name, type: e.entity_type })),
        themes: result.themes.map((t) => ({ label: t.label })),
      };
    };

    return { memoryWriter: writer, memoryRetriever: retriever };
  };

  return { store, index, ledger, namespace };
}
