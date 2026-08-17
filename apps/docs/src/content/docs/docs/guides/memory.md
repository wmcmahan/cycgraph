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

const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 5 * 60 * 1000 });
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

await index.rebuild(store);

const result = await retrieveMemory(store, index, {
  embedding: queryVector,
  limit: 20,
  minSimilarity: 0.5,
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
import { GraphRunner, reflection } from '@cycgraph/orchestrator';
import { retrieveMemory } from '@cycgraph/memory';

const memoryRetriever = async (query, options) => {
  const result = await retrieveMemory(store, index, {
    entityIds: query.entityIds,
    tags: query.tags ?? [],
    embedding: query.text ? await embed(query.text) : undefined,
    limit: options?.maxFacts ?? 20,
  });

  return {
    facts: result.facts.map(f => ({ content: f.content, validFrom: f.valid_from, id: f.id })),
    entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map(t => ({ label: t.label })),
  };
};

const runner = new GraphRunner(graph, state, { memoryRetriever });
```

:::tip[Tag-filtered retrieval is index-backed]
Passing `tags` pushes the filter into the store rather than scanning facts client-side, which is the reflection loop's hot path. The Postgres store (`@cycgraph/orchestrator-postgres`) resolves it via a GIN index on `memory_facts.tags` (migration `0015`) and returns results in a deterministic `valid_from DESC, id` order for stable pagination. Run the migration before relying on tag retrieval at scale.
:::

:::caution[memoryRetriever is opt-in per node]
The runner only calls `memoryRetriever` when an agent or supervisor node declares a `memoryQuery` directive. Without that, the retriever sits dormant and the option is silently a no-op. Add `memoryQuery` to every node that should receive retrieved memory:

```typescript
node({
  id: 'researcher',
  agent: researcher,
  writes: 'notes',
  memoryQuery: {
    tags: ['lesson'],
    maxFacts: 10,
  },
})
```

Query shapes:

- `memoryQuery: {}`: defaults `text` to `stateView.goal` (zero-config RAG).
- `memoryQuery: { tags: [...] }`: tag-only filter, no goal fallback.
- `memoryQuery: { entityIds: [...] }`: knowledge-graph subgraph extraction.
- `memoryQuery: { text: '...' }`: explicit semantic query.

Voting and evolution nodes propagate their `memory_query` automatically to every voter / candidate sub-node.
:::

### Memory writer (reflection)

To **persist** facts across runs, wire a `memoryWriter` and add a `reflection` node to your graph. The reflection node distills source memory keys into atomic facts and pushes them to your store; future runs retrieve them through `memoryRetriever`.

```typescript
import { node, graph, reflection, GraphRunner } from '@cycgraph/orchestrator';
import type { MemoryWriter } from '@cycgraph/orchestrator';

const writtenScopes = new Map<string, string[]>();

const memoryWriter: MemoryWriter = async (facts, options) => {
  const scope = options?.idempotencyKey;
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

const research = node({
  id: 'researcher',
  agent: researcher,
  writes: 'research_notes',
  memoryQuery: { tags: ['lesson'], maxFacts: 10 },
});

const reflect = reflection([research.writes], {
  id: 'reflect',
  reads: [research.writes],
  extractor: { type: 'rule_based', minSentenceLength: 25 },
  tags: ['lesson', 'graph:research-v1'],
});

const workflow = graph({
  name: 'Compound-learning research',
  description: 'Researcher writes notes, reflection extracts lessons for next run',
  nodes: [research, reflect],
  edges: [{ from: research, to: reflect }],
});

const runner = new GraphRunner(workflow, state, { memoryRetriever, memoryWriter });
```

See the [Reflection pattern](/docs/patterns/reflection/) for full details and the `learning-research-agent` example for a runnable demo.

### Combined with context compression

For the full pipeline, retrieve memory and then compress before injection:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import type { ContextCompressor } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, resolveModelProfile } from '@cycgraph/context-engine';

const pipeline = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor: ContextCompressor = (segments, options) => {
  const result = pipeline.compress({
    segments: segments.map((s) => ({
      id: s.id,
      content: s.content,
      role: s.role,
      priority: s.priority ?? 1,
      locked: s.locked ?? false,
    })),
    budget: {
      maxTokens:
        options?.maxTokens ??
        resolveModelProfile(options?.model)?.maxContextTokens ??
        8192,
      outputReserve: options?.outputReserve ?? 8_192,
    },
    query: options?.query,
  });

  return {
    segments: result.segments.map((s) => ({ id: s.id, content: s.content })),
    metrics: result.metrics,
  };
};

const runner = new GraphRunner(workflow, initialState, { memoryRetriever, contextCompressor });
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
  batchSize: 1000,
  logger: { warn: console.warn },
});

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
  supersessionDayThreshold: 1,
});

const conflicts = await detector.detectConflicts();
const resolution = await detector.autoResolveAll(conflicts);

console.log(`Resolved: ${resolution.resolved}, Needs review: ${resolution.skipped}`);

for (const detail of resolution.details.filter(d => d.action === 'skipped')) {
  console.log(`Conflict: ${detail.conflict.factA.content} vs ${detail.conflict.factB.content}`);
}
```

### Eval-gated retention

Keep a lesson only if runs that used it verifiably scored better. New lessons carry a `candidate` tag; the orchestrator records which facts were injected into each run (`getInjectedFactIds(finalState)`); you attribute each run's outcome score to those facts; and a retention gate promotes or evicts on the accumulated evidence:

```typescript
import {
  InMemoryOutcomeLedger,
  evaluateRetention,
  retrieveGatedLessons,
} from '@cycgraph/memory';
import { getInjectedFactIds } from '@cycgraph/orchestrator';

const ledger = new InMemoryOutcomeLedger();

const facts = await retrieveGatedLessons(store, {
  tags: ['lesson', 'graph:my-graph-v1'],
  maxFacts: 10,
  candidateSlots: 4,
  restAfterTrials: 5,
  ledger,
});

await ledger.recordOutcome({
  run_id: finalState.run_id,
  score,
  fact_ids: getInjectedFactIds(finalState),
});

const gate = await evaluateRetention(store, ledger, {
  minTrials: 3,
  decisionRule: 'inference',
  promoteMargin: 0.05,
  evictMargin: 0.05,
  promoteConfidence: 0.9,
  evictConfidence: 0.9,
  noiseFloorSd: 0.1,
  maxBaselineRuns: 40,
});
```

See the [Reflection pattern](/docs/patterns/reflection/#eval-gated-retention-verified-lessons) for the full lifecycle and foot-guns, and `packages/evals/examples/eval-gated-learning/` for a runnable demo where deliberately poisoned lessons are evicted on outcome evidence alone.

## Production deployment

### Postgres backend

For production, use the Drizzle-backed implementations from `@cycgraph/orchestrator-postgres`:

```typescript
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';

const store = new DrizzleMemoryStore();
const index = new DrizzleMemoryIndex();
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
await index.rebuild(store);
```

## Next steps

- [Memory System](/docs/concepts/memory/): architectural deep dive
- [Context Engine](/docs/concepts/context-engine/): compress memory before prompt injection
- [Context Engine Guide](/docs/guides/context-engine/): worked examples, including the memory-stack wiring
- [Persistence](/docs/concepts/persistence/): how workflow state persistence relates to memory
