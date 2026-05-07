---
title: Using Memory
description: Practical guide for integrating persistent memory into agent workflows.
---

This guide covers the practical steps for adding persistent memory to a workflow. For background on the hierarchy, knowledge graph, and consolidation system, see [Memory System](/concepts/memory/).

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
} from '@mcai/memory';

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
import { LLMExtractor } from '@mcai/memory';

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
import { GraphRunner } from '@mcai/orchestrator';
import { retrieveMemory } from '@mcai/memory';

const memoryRetriever = async (query, options) => {
  const result = await retrieveMemory(store, index, {
    entity_ids: query.entityIds,
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

### Combined with context compression

For the full pipeline — retrieve memory, then compress before injection:

```typescript
import { GraphRunner } from '@mcai/orchestrator';
import { createOptimizedPipeline, serialize } from '@mcai/context-engine';
import { retrieveMemory } from '@mcai/memory';

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
import { MemoryConsolidator } from '@mcai/memory';

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
import { ConflictDetector } from '@mcai/memory';

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

For production, use the Drizzle-backed implementations from `@mcai/orchestrator-postgres`:

```typescript
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@mcai/orchestrator-postgres';

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

- [Memory System](/concepts/memory/) — architectural deep dive
- [Context Engine](/concepts/context-engine/) — compress memory before prompt injection
- [Using the Context Engine](/guides/context-engine/) — compression integration guide
- [Persistence](/concepts/persistence/) — how workflow state persistence relates to memory
