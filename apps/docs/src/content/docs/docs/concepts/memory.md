---
title: Memory System
description: Temporal hierarchical knowledge graph for persistent agent memory across workflow runs.
---

The **Memory System** (`@cycgraph/memory`) provides a temporal knowledge graph with xMemory-inspired hierarchical organization. It gives agents persistent, queryable memory that survives across workflow runs — not just the ephemeral `WorkflowState.memory` that exists within a single execution.

The memory package is standalone with zero orchestrator dependencies. It works with any application or as the memory layer inside `@cycgraph/orchestrator` via the `memoryRetriever` option.

## Architecture

```
Messages (raw conversation turns)
  |  EpisodeSegmenter
Episodes (topic-coherent message groups)
  |  SemanticExtractor
SemanticFacts (atomic knowledge units)
  |  ThemeClusterer
Themes (high-level clusters)
```

Parallel to the hierarchy, a **knowledge graph** stores entities (nodes) and relationships (edges) with temporal validity windows. Retrieval combines both paths: top-down hierarchical search and BFS subgraph extraction.

### Memory hierarchy levels

| Level | Type | Description |
|-------|------|-------------|
| 0 | Messages | Raw conversation turns |
| 1 | Episodes | Groups of messages about one topic |
| 2 | SemanticFacts | Atomic facts distilled from episodes |
| 3 | Themes | Clusters of related facts |

Queries start at the theme level and drill down only as needed, reducing token usage by up to 50% compared to flat retrieval.

## Knowledge graph

Entities and relationships form a directed graph with temporal awareness:

- **Entities** — people, organizations, concepts, tools, locations
- **Relationships** — directed, weighted edges with `valid_from` / `valid_until` windows
- **Temporal invalidation** — old facts are soft-deleted (invalidated), not removed
- **Provenance tracking** — every record knows its origin (agent, tool, human, system, derived)

```typescript
import { InMemoryMemoryStore } from '@cycgraph/memory';
import type { Entity, Relationship } from '@cycgraph/memory';

const store = new InMemoryMemoryStore();

const aliceId = crypto.randomUUID();
const acmeId = crypto.randomUUID();

await store.putEntity({
  id: aliceId,
  name: 'Alice',
  entity_type: 'person',
  attributes: { role: 'engineer' },
  provenance: { source: 'agent', created_at: new Date() },
  created_at: new Date(),
  updated_at: new Date(),
});

await store.putEntity({
  id: acmeId,
  name: 'Acme Corp',
  entity_type: 'organization',
  attributes: {},
  provenance: { source: 'agent', created_at: new Date() },
  created_at: new Date(),
  updated_at: new Date(),
});

await store.putRelationship({
  id: crypto.randomUUID(),
  source_id: aliceId,
  target_id: acmeId,
  relation_type: 'work_at',
  weight: 1.0,
  attributes: {},
  valid_from: new Date('2024-01-01'),
  provenance: { source: 'agent', created_at: new Date() },
});
```

## Fact extraction

Three extractors convert episodes into atomic facts:

### SimpleSemanticExtractor

Minimal extraction: one fact per episode (the topic). Use for bootstrapping or when extraction quality doesn't matter.

### RuleBasedExtractor

Pattern-based extraction producing 3-10 facts per episode. Detects entities (capitalized names, @handles, camelCase, ACRONYMS) and relationships (work_at, manage, depend_on, and ~20 other base verbs with automatic inflection). Entity matching uses word boundaries to prevent false positives (e.g., "Smith" won't match inside "Blacksmith"). No LLM required.

```typescript
import { RuleBasedExtractor } from '@cycgraph/memory';

const extractor = new RuleBasedExtractor({ minSentenceLength: 20 });
const facts = await extractor.extract(episode);

// Standalone entity extraction
const entities = extractor.extractEntities('Alice Smith works at Acme Corp');
// [{ name: 'Alice Smith', type: 'person' }, { name: 'Acme Corp', type: 'organization' }]
```

### LLMExtractor

LLM-backed extraction for maximum quality. Uses an injectable `LLMProvider` interface (bring your own LLM). Falls back to `RuleBasedExtractor` on failure.

```typescript
import { LLMExtractor } from '@cycgraph/memory';
import type { LLMProvider } from '@cycgraph/memory';

const provider: LLMProvider = {
  complete: async (prompt) => { /* call your LLM */ return response; },
};

const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });
const facts = await extractor.extract(episode);
```

## Theme clustering

### SimpleThemeClusterer

Greedy single-pass assignment: each fact joins the most similar existing theme (by embedding cosine similarity) or creates a new one.

### ConsolidatingThemeClusterer

Two-pass clustering that prevents theme proliferation:

1. **Assignment pass** — same greedy assignment as `SimpleThemeClusterer`
2. **Merge pass** — pairwise cosine similarity between all theme centroids; themes above `mergeThreshold` are merged, centroids recomputed

```typescript
import { ConsolidatingThemeClusterer } from '@cycgraph/memory';

const clusterer = new ConsolidatingThemeClusterer({
  assignmentThreshold: 0.7,  // min similarity to join existing theme
  mergeThreshold: 0.85,      // merge themes above this similarity
  maxThemes: 50,             // soft cap
});

const themes = await clusterer.cluster(facts, existingThemes);
```

## Retrieval

### Hierarchical retrieval (embedding-based)

Top-down search: match themes by embedding similarity, expand to facts, apply temporal filters, expand to episodes, collect entities and relationships.

```typescript
import { retrieveMemory } from '@cycgraph/memory';

const result = await retrieveMemory(store, index, {
  embedding: queryVector,
  limit: 20,
  min_similarity: 0.5,
  valid_at: new Date(),          // only currently-valid facts
  changed_since: lastQueryTime,  // only recent changes
});
// result.themes, result.facts, result.episodes, result.entities, result.relationships
```

### Entity-based retrieval

When you have specific entity IDs, retrieval uses BFS subgraph extraction:

```typescript
const result = await retrieveMemory(store, index, {
  entity_ids: [aliceId, bobId],
  max_hops: 2,
  limit: 20,
});
```

### Temporal filtering

```typescript
import { isValidAt, filterValid } from '@cycgraph/memory';

isValidAt(relationship, new Date());  // within [valid_from, valid_until)?

const validFacts = filterValid(allFacts, {
  valid_at: new Date(),
  changed_since: lastSync,
  include_invalidated: false,
});
```

## Memory consolidation

Over time, memory accumulates duplicates, outdated facts, and contradictions. The consolidation system manages the lifecycle:

### MemoryConsolidator

Prunes and deduplicates memory records to stay within budget:

```typescript
import { MemoryConsolidator } from '@cycgraph/memory';

const consolidator = new MemoryConsolidator(store, index, {
  maxFacts: 1000,           // prune lowest-scoring facts over this count
  maxEpisodes: 100,         // prune oldest episodes over this count
  decayHalfLifeDays: 30,    // time-based relevance decay
  dedupThreshold: 0.9,      // cosine similarity for near-duplicate detection
  deleteMode: 'soft',       // 'soft' (invalidate) or 'hard' (delete)
  batchSize: 1000,          // paginated fact loading (avoids OOM on large stores)
  logger: { warn: console.warn },  // optional structured logging
});

const report = await consolidator.consolidate();
// report.factsDeduped      — near-duplicates merged
// report.factsDecayed      — low-relevance facts pruned
// report.episodesPruned    — old episodes removed
// report.themesCleanedUp   — themes with updated fact_ids
// report.themesRemoved     — empty themes deleted
```

Consolidation cascades to themes: when facts are pruned, the themes that referenced them have their `fact_ids` updated and their embeddings recomputed. Themes with zero remaining facts are deleted.

### ConflictDetector

Identifies contradictory, negating, or superseding facts:

```typescript
import { ConflictDetector } from '@cycgraph/memory';

const detector = new ConflictDetector(store, index, {
  autoResolveSupersession: true,
  embeddingThreshold: 0.8,
  policy: 'negation-invalidates-positive',
});

const conflicts = await detector.detectConflicts();

// Auto-resolve with configured policy
const resolution = await detector.autoResolveAll(conflicts);
```

Three conflict types:

| Type | Detection | Confidence |
|------|-----------|------------|
| `negation` | One fact contains negation words, high word overlap | 0.8 |
| `supersession` | Same entities, similar content, >N days apart (configurable via `supersessionDayThreshold`, default 1) | 0.9 |
| `semantic_contradiction` | High embedding similarity, shared entities, low text overlap | 0.3-0.7 (scaled by fact length) |

Three resolution policies:

| Policy | Behavior |
|--------|----------|
| `supersede-on-newer` | Always keep the newer fact |
| `negation-invalidates-positive` | Keep the negation (the correction), use temporal order for supersession, skip semantic contradictions |
| `manual-review` | Return all conflicts unresolved |

## Storage backends

| Backend | Package | Use Case |
|---------|---------|----------|
| `InMemoryMemoryStore` | `@cycgraph/memory` | Testing and lightweight use |
| `InMemoryMemoryIndex` | `@cycgraph/memory` | Brute-force cosine similarity |
| `DrizzleMemoryStore` | `@cycgraph/orchestrator-postgres` | Production Postgres |
| `DrizzleMemoryIndex` | `@cycgraph/orchestrator-postgres` | pgvector HNSW indexes |

```typescript
// Production setup
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';

const store = new DrizzleMemoryStore();
const index = new DrizzleMemoryIndex();
```

## Orchestrator integration

Memory hooks into the runner in two places: agent nodes **read** memory through `memoryRetriever`, and `reflection` nodes **write** to memory through `memoryWriter`.

### Reading: `memoryRetriever` + `memory_query`

Inject memory retrieval into `GraphRunner` via the `memoryRetriever` option. **The retriever only fires when a node declares a `memory_query` directive** — without that, no agent calls happen against the memory store and the option is silently a no-op.

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { InMemoryMemoryStore, InMemoryMemoryIndex, retrieveMemory } from '@cycgraph/memory';

const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();

const memoryRetriever = async (query, options) => {
  const result = await retrieveMemory(store, index, {
    entity_ids: query.entityIds,
    tags: query.tags ?? [],
    limit: options?.maxFacts ?? 20,
  });
  return {
    facts: result.facts.map(f => ({ content: f.content, validFrom: f.valid_from })),
    entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map(t => ({ label: t.label })),
  };
};

const graph = createGraph({
  name: 'Research',
  description: 'Research with prior knowledge',
  nodes: [
    {
      id: 'researcher',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal'],
      write_keys: ['notes'],
      // This is the directive that activates the retriever.
      memory_query: {
        tags: ['lesson'],   // retrieve facts tagged 'lesson'
        max_facts: 10,
      },
    },
    // ...
  ],
  // ...
});

const runner = new GraphRunner(graph, state, { memoryRetriever });
```

The runner calls `memoryRetriever` once before building the agent's prompt, then renders results into a `## Relevant Memory` section ahead of the workflow-state memory block.

**Query shapes:**

| Shape | Behaviour |
|---|---|
| `memory_query: {}` | Defaults `text` to `stateView.goal` — RAG-style with zero config. |
| `memory_query: { tags: [...] }` | Tag-only retrieval. No text fallback. |
| `memory_query: { entity_ids: [...] }` | Knowledge-graph subgraph extraction. |
| `memory_query: { text: '...' }` | Explicit semantic search text. |

### Writing: `memoryWriter` + `reflection` nodes

To **persist** facts back into the memory store across runs, attach a `reflection` node and inject a `memoryWriter`:

```typescript
import type { MemoryWriter } from '@cycgraph/orchestrator';

const memoryWriter: MemoryWriter = async (facts) => {
  const ids: string[] = [];
  for (const fact of facts) {
    const stored = {
      id: crypto.randomUUID(),
      content: fact.content,
      source_episode_ids: [],
      entity_ids: [],
      provenance: { source: fact.provenance.source, created_at: new Date(), run_id: fact.provenance.run_id, node_id: fact.provenance.node_id },
      valid_from: new Date(),
      tags: fact.tags,
    };
    await store.putFact(stored);
    ids.push(stored.id);
  }
  return { fact_ids: ids };
};

const runner = new GraphRunner(graph, state, { memoryRetriever, memoryWriter });
```

A `reflection` node at the end of the graph distills `research_notes` (or any source key) into facts and calls `memoryWriter`. Future runs pick those facts up through `memoryRetriever` with a matching `tags` query. See the [Reflection pattern](/docs/patterns/reflection/) and the `learning-research-agent` example for the full loop.

**Deduplication contract:** the runner passes `options.idempotency_key` (formatted `run_id:node_id:iteration`) on every write. The same key is passed again when a write repeats for the same node execution — after a node retry or crash recovery. Writers SHOULD treat a repeated key as "already written" (skip or upsert); ignoring it duplicates facts in long-term memory on every retry. See the [Reflection pattern](/docs/patterns/reflection/) for a writer that implements the dedup.

## Next steps

- [Workflow State](/docs/concepts/workflow-state/) — ephemeral per-run memory vs persistent knowledge graph
- [Context Engine](/docs/concepts/context-engine/) — compress memory payloads before prompt injection
- [Using Memory](/docs/guides/memory/) — practical guide for integrating memory into workflows
- [Reflection pattern](/docs/patterns/reflection/) — compound learning across runs
- [Persistence](/docs/concepts/persistence/) — how workflow state is persisted alongside memory
