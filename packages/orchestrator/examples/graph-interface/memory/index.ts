import type { MemoryRetriever, MemoryWriter } from '@cycgraph/orchestrator';
import { InMemoryMemoryStore, InMemoryMemoryIndex, checkFactAdmission, retrieveMemory } from '@cycgraph/memory';
import type { Provenance, SemanticFact } from '@cycgraph/memory';

export const LESSON_TAG = 'graph:research-block';

const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();

export const memoryWriter: MemoryWriter = async (facts) => {
  const now = new Date();
  const ids: string[] = [];

  for (const fact of facts) {
    const verdict = await checkFactAdmission(store, { content: fact.content }, { tags: [LESSON_TAG] });

    if (!verdict.admit) {
      continue;
    }

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
      tags: fact.tags,
    };
    await store.putFact(stored);
    ids.push(stored.id);
  }

  return { fact_ids: ids };
};

export const memoryRetriever: MemoryRetriever = async (query, options) => {
  const result = await retrieveMemory(store, index, {
    tags: query.tags ?? [LESSON_TAG],
    maxHops: 0,
    limit: options?.maxFacts ?? 20,
    minSimilarity: 0,
    includeInvalidated: false,
  });

  return {
    facts: result.facts.map((f) => ({ content: f.content, validFrom: f.valid_from, id: f.id })),
    entities: result.entities.map((e) => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map((t) => ({ label: t.label })),
  };
};

