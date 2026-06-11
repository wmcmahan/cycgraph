<div align="center">

# @cycgraph/memory

**A temporal knowledge graph + hierarchical memory layer for TypeScript LLM agents.**

[![npm](https://img.shields.io/npm/v/@cycgraph/memory?color=cb3837)](https://www.npmjs.com/package/@cycgraph/memory)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Standalone](https://img.shields.io/badge/standalone-zero%20deps%20except%20zod-3b82f6)](#zero-dependency-core)

[📚 Documentation](https://flattop.io/concepts/memory/) &nbsp;·&nbsp; [📖 Strategy](./STRATEGY.md) &nbsp;·&nbsp; [🧪 Examples](../orchestrator/examples/learning-research-agent/)

</div>

---

`@cycgraph/memory` is a **temporal knowledge graph** with **xMemory-inspired hierarchical retrieval**. Designed for TypeScript LLM applications that want richer recall than a flat similarity search — provenance, time-bounded validity, entity relationships, and a hierarchy that lets prompts drill down only when they need to. Works standalone with any LLM stack — Vercel AI SDK, LangChain.js, raw `fetch` — or drops into [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator) for cross-run agent learning.

## What this package gives you

A vector store handles "find similar to this query." This package adds the structure around it:

- **Temporal validity** — every record carries `valid_from` / `valid_until`. Facts are invalidated, not deleted, so you can ask "what was true on 2026-01-15?" without losing the audit trail.
- **Entities + typed relationships** — a directed graph alongside the embedding layer. Facts can be reached by similarity, by tag, **or** by walking out from an entity ID.
- **xMemory-inspired hierarchy** — messages → episodes → facts → themes. Queries can start at the theme level and drill down only when more detail is needed, reducing prompt tokens versus returning every matching fact.
- **Retrieval paths that don't require embeddings** — query by `tags`, by `entity_ids`, or by full embedding similarity. Pick whichever the situation calls for; you don't need to wire an embedding provider just to retrieve by tag.
- **Provenance on every record** — `source: 'agent' | 'tool' | 'human' | 'system' | 'derived'` plus optional `run_id` / `node_id` / `agent_id`. Useful for trust, audit, and debugging "why is this fact here?"
- **Same interface, in-memory or Postgres** — develop against `InMemoryMemoryStore`, ship against [`DrizzleMemoryStore`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres). One-line swap.

## What you can build with it

- **Agents that learn across sessions** — store distilled lessons after each run, retrieve them by tag in the next.
- **RAG with temporal awareness** — ask "what was true on 2026-01-15?" not just "what's in the embedding store right now."
- **Knowledge graphs for support / triage workflows** — entities, relationships, episode-grouped conversations.
- **Memory for any LLM stack** — Vercel AI SDK, LangChain.js, the OpenAI SDK directly. No orchestrator required.

## Install

```bash
npm install @cycgraph/memory
```

Zero runtime dependencies except [`zod`](https://github.com/colinhacks/zod). In-memory implementations included — drop in a Postgres backend later via [`@cycgraph/orchestrator-postgres`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres).

## Quick taste

```typescript
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  RuleBasedExtractor,
  SimpleEpisodeSegmenter,
  retrieveMemory,
} from '@cycgraph/memory';

const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();

// 1. Ingest some messages — segment into episodes, extract facts + entities + relationships
const segmenter = new SimpleEpisodeSegmenter({ gap_threshold_ms: 5 * 60 * 1000 });
const extractor = new RuleBasedExtractor({ minSentenceLength: 15 });

const messages = [
  { id: crypto.randomUUID(), role: 'user', content: 'Alice works at Acme Corp.', timestamp: new Date(), metadata: {} },
  { id: crypto.randomUUID(), role: 'assistant', content: 'Acme Corp acquired Widget Co in 2024.', timestamp: new Date(), metadata: {} },
];

for (const ep of await segmenter.segment(messages)) {
  await store.putEpisode(ep);
  const { facts, entities, relationships } = await extractor.extract(ep);
  for (const f of facts) await store.putFact(f);
  for (const e of entities) await store.putEntity(e);
  for (const r of relationships) await store.putRelationship(r);
}

// 2. Retrieve facts by tag (no embedding provider needed)
const result = await retrieveMemory(store, index, {
  tags: ['business'],
  max_hops: 0, limit: 10, min_similarity: 0, include_invalidated: false,
});
console.log(result.facts.map(f => f.content));
```

## The xMemory hierarchy

```
Messages              ← raw conversation turns
   ↓  EpisodeSegmenter
Episodes              ← topic-coherent groups
   ↓  SemanticExtractor (rule-based or LLM-driven)
SemanticFacts         ← atomic, self-contained knowledge units
   ↓  ThemeClusterer
Themes                ← high-level clusters
```

Retrieval starts at the **theme** level and drills down only as needed — themes give the gist in 1-2 sentences each, facts give the details, episodes give the source conversation. Reduces token usage by ~50% versus flat vector retrieval over the same corpus.

Parallel to the hierarchy, a **knowledge graph** stores entities (typed nodes) and relationships (directed, weighted, temporally-bounded edges). Queries can start from an entity ID and BFS out — useful for "who else interacts with this person?" or "what other facts mention this concept?"

## Retrieval paths

```typescript
import { retrieveMemory } from '@cycgraph/memory';

// Path 1 — Tag-only (no embedding needed)
await retrieveMemory(store, index, {
  tags: ['lesson', 'graph:research-v1'],
  limit: 20, max_hops: 0, min_similarity: 0, include_invalidated: false,
});

// Path 2 — Entity-based (knowledge graph traversal)
await retrieveMemory(store, index, {
  entity_ids: [aliceId],
  max_hops: 2,    // ← walk 2 hops out from Alice
  limit: 20, min_similarity: 0.5, include_invalidated: false,
});

// Path 3 — Embedding-based (semantic similarity over themes → facts)
await retrieveMemory(store, index, {
  embedding: await embed('source credibility methodology'),
  limit: 20, max_hops: 0, min_similarity: 0.5, include_invalidated: false,
});

// Combine any path with temporal filtering
await retrieveMemory(store, index, {
  tags: ['lesson'],
  valid_at: new Date('2026-01-15'),  // ← what was true on this date?
  limit: 20, max_hops: 0, min_similarity: 0, include_invalidated: false,
});
```

## Memory consolidation

Long-lived stores grow. The bundled `MemoryConsolidator` deduplicates near-identical facts, applies time-decay scoring to prune low-relevance facts, and removes orphaned themes — keeping the store within budget without losing the audit trail.

```typescript
import { MemoryConsolidator } from '@cycgraph/memory';

const consolidator = new MemoryConsolidator(store, index, {
  maxFacts: 10_000,
  decayHalfLifeDays: 30,
  dedupThreshold: 0.9,
  deleteMode: 'soft',   // invalidate, don't hard-delete
});

const report = await consolidator.consolidate();
console.log(`pruned ${report.totalReclaimed} records`);
```

A separate `ConflictDetector` finds facts that semantically contradict each other and applies a resolution policy (keep newest / keep highest-confidence / mark all conflicting). Useful in long-running stores where the LLM extracts subtly different versions of the same fact over time.

## Standalone or as cycgraph's memory layer

This package was built to work either way.

**Standalone** — Use it as the persistent memory layer for any TS LLM application. The retrieval result includes `facts`, `entities`, `themes`, `episodes`, and `relationships` — render them into your own prompt format.

**With `@cycgraph/orchestrator`** — A `reflection` node distills workflow output into facts and writes them via the `MemoryWriter` adapter; agent nodes declare a `memory_query` directive and the runner auto-injects retrieved facts into prompts. See [`examples/learning-research-agent`](../orchestrator/examples/learning-research-agent/).

## Backends

| Backend | Package | Use case |
|---|---|---|
| `InMemoryMemoryStore` + `InMemoryMemoryIndex` | this package | Dev, tests, single-process apps. Zero dependencies. |
| `DrizzleMemoryStore` + `DrizzleMemoryIndex` | [`@cycgraph/orchestrator-postgres`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres) | Production. Postgres + pgvector. Same interface — swap one line. |

```typescript
// Dev
import { InMemoryMemoryStore, InMemoryMemoryIndex } from '@cycgraph/memory';
const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();

// Production
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';
const store = new DrizzleMemoryStore(db);
const index = new DrizzleMemoryIndex(db);
```

## Extractors

Three extractors ship with the package — pick by trade-off:

| Extractor | LLM call? | Output |
|---|---|---|
| `SimpleSemanticExtractor` | No | One fact per episode topic. Fast, minimal coverage. |
| `RuleBasedExtractor` | No | Multi-fact extraction with regex-based entity detection + verb-inflection relationship matching. |
| `LLMExtractor` | Yes | Structured-output extraction via any LLM. Falls back to `RuleBasedExtractor` on parse failure. |

Custom extractors: implement the `SemanticExtractor` interface (one method, `extract(episode) → ExtractionResult`).

## Documentation

- **[Memory concept guide](https://flattop.io/concepts/memory/)** — the full architecture
- **[Memory usage guide](https://flattop.io/guides/memory/)** — recipes for ingesting, retrieving, consolidating
- **[Reflection pattern](https://flattop.io/patterns/reflection/)** — compound learning across runs
- **[Strategy doc](./STRATEGY.md)** — the research foundation (xMemory, Zep, temporal graphs)

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).