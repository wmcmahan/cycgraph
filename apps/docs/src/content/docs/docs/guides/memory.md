---
title: Using Memory
description: Practical guide for integrating persistent memory into agent workflows.
---

This guide covers the practical steps for adding persistent memory to a workflow. For background on the hierarchy, knowledge graph, and consolidation system, see [Memory System](/docs/concepts/memory/).

## Quick start

Ingest messages, extract facts, and query memory in a few lines:

```typescript
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  RuleBasedExtractor,
  ConsolidatingThemeClusterer,
  retrieveMemory,
} from '@cycgraph/memory';

const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();

// 1. Ingest messages into the hierarchy
const segmenter = new SimpleEpisodeSegmenter({ gap_threshold_ms: 5 * 60 * 1000 });
const extractor = new RuleBasedExtractor();
const clusterer = new ConsolidatingThemeClusterer();

const episodes = await segmenter.segment(messages);
for (const ep of episodes) {
  await store.putEpisode(ep);
  const facts = await extractor.extract(ep);
  for (const fact of facts) {
    await store.putFact(fact);
  }
}

const allFacts = await store.findFacts();
const themes = await clusterer.cluster(allFacts);
for (const theme of themes) {
  await store.putTheme(theme);
}

// 2. Rebuild search index
await index.rebuild(store);

// 3. Query by embedding
const result = await retrieveMemory(store, index, {
  embedding: queryVector,
  limit: 20,
  min_similarity: 0.5,
});
```

## Choosing an extractor

| Extractor | Quality | Speed | Dependencies |
|-----------|---------|-------|-------------|
| `SimpleSemanticExtractor` | Low (1 fact/episode) | Instant | None |
| `RuleBasedExtractor` | Medium (3-10 facts/episode) | Fast | None |
| `LLMExtractor` | High (N facts/episode) | Slow (LLM call) | LLM provider |

Start with `RuleBasedExtractor` for most use cases. Use `LLMExtractor` when extraction quality directly impacts downstream results:

```typescript
import { LLMExtractor } from '@cycgraph/memory';

const extractor = new LLMExtractor({
  provider: { complete: (prompt) => callYourLLM(prompt) },
  maxFactsPerEpisode: 20,
});
```

The LLM extractor falls back to `RuleBasedExtractor` automatically on any failure (parse error, timeout, malformed output).

## Wiring into the orchestrator

### Memory retriever

Inject a `memoryRetriever` into `GraphRunner` so agents receive relevant memory in their prompts:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { retrieveMemory } from '@cycgraph/memory';

const memoryRetriever = async (query, options) => {
  const result = await retrieveMemory(store, index, {
    entity_ids: query.entityIds,
    tags: query.tags ?? [],
    embedding: query.text ? await embed(query.text) : undefined,
    limit: options?.maxFacts ?? 20,
  });

  return {
    facts: result.facts.map(f => ({ content: f.content, validFrom: f.valid_from })),
    entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map(t => ({ label: t.label })),
  };
};

const runner = new GraphRunner(graph, state, { memoryRetriever });
```

:::tip[Tag-filtered retrieval is index-backed]
Passing `tags` pushes the filter into the store rather than scanning facts client-side — this is the reflection loop's hot path. The Postgres store (`@cycgraph/orchestrator-postgres`) resolves it via a GIN index on `memory_facts.tags` (migration `0015`) and returns results in a deterministic `valid_from DESC, id` order for stable pagination. Run the migration before relying on tag retrieval at scale.
:::

:::caution[memoryRetriever is opt-in per node]
The runner only calls `memoryRetriever` when an agent or supervisor node declares a `memory_query` directive. Without that, the retriever sits dormant and the option is silently a no-op. Add `memory_query` to every node that should receive retrieved memory:

```typescript
{
  id: 'researcher',
  type: 'agent',
  agent_id: RESEARCHER_ID,
  read_keys: ['goal'],
  write_keys: ['notes'],
  memory_query: {
    tags: ['lesson'],   // tag-only retrieval
    max_facts: 10,
  },
}
```

Query shapes:

- `memory_query: {}` — defaults `text` to `stateView.goal` (zero-config RAG).
- `memory_query: { tags: [...] }` — tag-only filter; no goal fallback.
- `memory_query: { entity_ids: [...] }` — knowledge-graph subgraph extraction.
- `memory_query: { text: '...' }` — explicit semantic query.

Voting and evolution nodes propagate their `memory_query` automatically to every voter / candidate sub-node.
:::

### Memory writer (reflection)

To **persist** facts across runs, wire a `memoryWriter` and add a `reflection` node to your graph. The reflection node distills source memory keys into atomic facts and pushes them to your store; future runs retrieve them through `memoryRetriever`.

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import type { MemoryWriter } from '@cycgraph/orchestrator';

// The runner passes options.idempotency_key (`run_id:node_id:iteration`)
// so writers can dedupe repeated writes for the same node execution —
// node retries and crash recovery re-invoke the writer, and ignoring the
// key duplicates facts in long-term memory.
const writtenScopes = new Map<string, string[]>();

const memoryWriter: MemoryWriter = async (facts, options) => {
  const scope = options?.idempotency_key;
  if (scope && writtenScopes.has(scope)) {
    return { fact_ids: writtenScopes.get(scope)! };
  }

  const ids: string[] = [];
  for (const fact of facts) {
    const stored = {
      id: crypto.randomUUID(),
      content: fact.content,
      source_episode_ids: [],
      entity_ids: [],
      provenance: {
        source: fact.provenance.source,
        created_at: new Date(),
        run_id: fact.provenance.run_id,
        node_id: fact.provenance.node_id,
      },
      valid_from: new Date(),
      tags: fact.tags,
    };
    await store.putFact(stored);
    ids.push(stored.id);
  }
  if (scope) writtenScopes.set(scope, ids);
  return { fact_ids: ids };
};

const graph = createGraph({
  name: 'Compound-learning research',
  description: 'Researcher writes notes, reflection extracts lessons for next run',
  nodes: [
    {
      id: 'researcher',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal'],
      write_keys: ['research_notes'],
      memory_query: { tags: ['lesson'], max_facts: 10 },
    },
    {
      id: 'reflect',
      type: 'reflection',
      read_keys: ['research_notes'],
      write_keys: ['research_notes_reflection'],
      reflection_config: {
        source_keys: ['research_notes'],
        extractor: { type: 'rule_based', min_sentence_length: 25 },
        tags: ['lesson', 'graph:research-v1'],
      },
    },
  ],
  edges: [{ source: 'researcher', target: 'reflect' }],
  start_node: 'researcher',
  end_nodes: ['reflect'],
});

const runner = new GraphRunner(graph, state, { memoryRetriever, memoryWriter });
```

See the [Reflection pattern](/docs/patterns/reflection/) for full details and the `learning-research-agent` example for a runnable demo.

### Combined with context compression

For the full pipeline — retrieve memory, then compress before injection:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, serialize } from '@cycgraph/context-engine';
import { retrieveMemory } from '@cycgraph/memory';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{ id: 'memory', content: serialize(sanitizedMemory), role: 'memory', priority: 1 }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { memoryRetriever, contextCompressor });
```

## Memory lifecycle management

### Periodic consolidation

Run consolidation periodically to keep memory within budget and remove duplicates:

```typescript
import { MemoryConsolidator } from '@cycgraph/memory';

const consolidator = new MemoryConsolidator(store, index, {
  maxFacts: 1000,
  maxEpisodes: 200,
  decayHalfLifeDays: 30,
  dedupThreshold: 0.9,
  batchSize: 1000,           // paginated fact loading for large stores
  logger: { warn: console.warn },
});

// Run after each workflow, or on a schedule
const report = await consolidator.consolidate();
console.log(`Reclaimed ${report.totalReclaimed} records`);
console.log(`Themes cleaned: ${report.themesCleanedUp}, removed: ${report.themesRemoved}`);
```

### Conflict resolution

Detect and resolve contradictory facts:

```typescript
import { ConflictDetector } from '@cycgraph/memory';

const detector = new ConflictDetector(store, index, {
  policy: 'negation-invalidates-positive',
  autoResolveSupersession: true,
  supersessionDayThreshold: 1,  // configurable; default 1 day
});

const conflicts = await detector.detectConflicts();
const resolution = await detector.autoResolveAll(conflicts);

console.log(`Resolved: ${resolution.resolved}, Needs review: ${resolution.skipped}`);

// Manual review of remaining conflicts
for (const detail of resolution.details.filter(d => d.action === 'skipped')) {
  console.log(`Conflict: ${detail.conflict.factA.content} vs ${detail.conflict.factB.content}`);
}
```

## Production deployment

### Postgres backend

For production, use the Drizzle-backed implementations from `@cycgraph/orchestrator-postgres`:

```typescript
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';

const store = new DrizzleMemoryStore();   // uses pgvector for embeddings
const index = new DrizzleMemoryIndex();   // HNSW indexes for fast similarity search
```

The Postgres backend provides:
- pgvector HNSW indexes for sub-millisecond similarity search
- Batch methods using `WHERE id = ANY($1)` for efficient bulk retrieval
- Join table (`memory_entity_facts`) for fast entity-based fact lookups
- Automatic index maintenance (no manual `rebuild()` needed)

### Embedding provider

The memory system is embedding-agnostic. Provide embeddings when storing records for similarity search:

```typescript
const entity = {
  ...entityData,
  embedding: await embed(entityData.name + ' ' + entityData.entity_type),
};
await store.putEntity(entity);

// Rebuild in-memory index after adding records
await index.rebuild(store);
// DrizzleMemoryIndex does not need rebuilding
```

## Next steps

- [Memory System](/docs/concepts/memory/) — architectural deep dive
- [Context Engine](/docs/concepts/context-engine/) — compress memory before prompt injection
- [Using the Context Engine](/docs/guides/context-engine/) — compression integration guide
- [Persistence](/docs/concepts/persistence/) — how workflow state persistence relates to memory
