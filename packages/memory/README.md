<div align="center">

# @cycgraph/memory

**A temporal knowledge graph + hierarchical memory layer**

[![npm](https://img.shields.io/npm/v/@cycgraph/memory?color=cb3837)](https://www.npmjs.com/package/@cycgraph/memory)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Standalone](https://img.shields.io/badge/standalone-zero%20deps%20except%20zod-3b82f6)](#zero-dependency-core)

</div>

---

A utility package for building temporal knowledge graphs with xMemory-inspired hierarchical retrieval. Designed for TypeScript applications that want richer recall than a flat similarity search — provenance, time-bounded validity, entity relationships, and a hierarchy that lets prompts drill down only when they need to. Works standalone with any stack, or drops into [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator) for cross-run agent learning.

- **[Memory concept guide](https://flattop.io/docs/concepts/memory/)** — the full architecture
- **[Memory usage guide](https://flattop.io/docs/guides/memory/)** — recipes for ingesting, retrieving, consolidating
- **[Reflection pattern](https://flattop.io/docs/patterns/reflection/)** — compound learning across runs


## Install

```bash
npm install @cycgraph/memory
```

**Optional packages**

- [@cycgraph/orchestrator-postgres](./packages/orchestrator-postgres) - Postgres + pgvector adapter for durable state, event log, agent registry, and memory store.

## Core Concepts

- **Temporal validity** — every record carries validity date ranges, where facts are invalidated, not deleted, so you can ask "what was true on 2026-01-15?" without losing the audit trail.
- **Entities + typed relationships** — a directed graph alongside the embedding layer. Facts can be reached by similarity, by tag or by walking out from an entity ID.
- **xMemory-inspired hierarchy** — Queries can start at the theme level and drill down only when more detail is needed, reducing prompt tokens versus returning every matching fact.
- **Retrieval paths that don't require embeddings** — query by tags, by entity IDs, or by full embedding similarity. Pick whichever the situation calls for.
- **Provenance on every record** — useful for trust, audit, and debugging.
- **Same interface, in-memory or Postgres** — develop against in-memory store, ship with Postgres adapter. One-line swap.

## Use Cases

- **Agents that learn across sessions** — store distilled lessons after each run, retrieve them by tag in the next.
- **RAG with temporal awareness** — ask "what was true on 2026-01-15?" not just "what's in the embedding store right now."
- **Knowledge graphs for support / triage workflows** — entities, relationships, episode-grouped conversations.
- **Memory for any LLM stack** — Vercel AI SDK, LangChain.js, the OpenAI SDK directly. No orchestrator required.


## Example

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

/**
 * 1. Ingest messages → episodes → facts
 */
const segmenter = new SimpleEpisodeSegmenter({ gap_threshold_ms: 30000 });
const extractor = new RuleBasedExtractor({ minSentenceLength: 15 });

const messages = [
  {
    id: crypto.randomUUID(),
    role: 'user',
    content: 'Alice works at Acme Corp.',
    timestamp: new Date(),
    metadata: {},
  },
  {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: 'Acme Corp acquired Widget Co in 2024.',
    timestamp: new Date(),
    metadata: {},
  },
];

for (const ep of await segmenter.segment(messages)) {
  await store.putEpisode(ep);
  const extracted = await extractor.extract(ep);

  for (const f of extracted.facts) {
    await store.putFact(f);
  }
  for (const e of extracted.entities) {
    await store.putEntity(e);
  }
  for (const r of extracted.relationships) {
    await store.putRelationship(r);
  }
}

/**
 * 2. Retrieve
 * - by tag (no embedding provider needed)
 * - by entity (no embedding provider needed)
 * - by embedding (requires embedding provider)
 * - combinations of the above
 */
const result = await retrieveMemory(store, index, {
  tags: ['business'],
  max_hops: 0,
  limit: 10,
  min_similarity: 0,
  include_invalidated: false,
});
```

For Postgres and pgvector backed, see [`@cycgraph/orchestrator-postgres`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres).

```typescript
import {
  DrizzleMemoryStore,
  DrizzleMemoryIndex
} from '@cycgraph/orchestrator-postgres';

const store = new DrizzleMemoryStore(db);
const index = new DrizzleMemoryIndex(db);
```

## Retrieval patterns

**Tag-only (no embedding needed)**

```typescript
await retrieveMemory(store, index, {
  tags: ['lesson', 'graph:research-v1'],
  limit: 20,
  max_hops: 0,
  min_similarity: 0,
  include_invalidated: false,
});
```

**Entity-based (knowledge graph traversal)**

```typescript
await retrieveMemory(store, index, {
  entity_ids: [aliceId],
  max_hops: 2,
  limit: 20,
  min_similarity: 0.5,
  include_invalidated: false,
});
```

**Embedding-based (semantic similarity over themes → facts)**

```typescript
await retrieveMemory(store, index, {
  embedding: await embed('source credibility methodology'),
  limit: 20,
  max_hops: 0,
  min_similarity: 0.5,
  include_invalidated: false,
});
```

**Temporal filtering**

```typescript
await retrieveMemory(store, index, {
  valid_at: new Date('2026-01-15'),
  limit: 20,
  max_hops: 0,
  min_similarity: 0,
  include_invalidated: false,
});
```

## Memory consolidation

The memory consolidator deduplicates near-identical facts, applies time-decay scoring to prune low-relevance facts, and removes orphaned themes while keeping the store within budget without losing the audit trail.

```typescript
import { MemoryConsolidator } from '@cycgraph/memory';

const consolidator = new MemoryConsolidator(store, index, {
  maxFacts: 10_000,
  decayHalfLifeDays: 30,
  dedupThreshold: 0.9,
  deleteMode: 'soft',
});

const report = await consolidator.consolidate();
```

A separate `ConflictDetector` finds facts that semantically contradict each other and applies a resolution policy (keep newest / keep highest-confidence / mark all conflicting). Useful in long-running stores where the LLM extracts subtly different versions of the same fact over time.

## Extractors

Extractors are pluggable components that extract facts, entities, and relationships from episodes.

#### SimpleSemanticExtractor
One fact per episode topic. Fast, minimal coverage. No LLM required.

```typescript
import { SimpleSemanticExtractor } from '@cycgraph/memory';

const extractor = new SimpleSemanticExtractor();
const facts = await extractor.extract(episode);
```

#### RuleBasedExtractor
Multi-fact extraction with regex-based entity detection + verb-inflection relationship matching. No LLM required.

```typescript
import { RuleBasedExtractor } from '@cycgraph/memory';

const extractor = new RuleBasedExtractor({ minSentenceLength: 20 });
const facts = await extractor.extract(episode);
```

#### LLMExtractor
Uses an LLM to extract facts, entities, and relationships from episodes. Falls back to `RuleBasedExtractor` on parse failure.

```typescript
import { LLMExtractor } from '@cycgraph/memory';
import type { LLMProvider } from '@cycgraph/memory';

const provider: LLMProvider = {
  complete: async (prompt) => {
    // call your LLM
    return response;
  },
};

const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });
const facts = await extractor.extract(episode);
```

## Eval-gated retention

Lessons shouldn't live forever just because an agent once wrote them down. The eval-gating primitives keep a lesson only if runs that used it verifiably scored better:

```typescript
import {
  InMemoryOutcomeLedger,
  evaluateRetention,
  retrieveGatedLessons,
} from '@cycgraph/memory';

const ledger = new InMemoryOutcomeLedger();

await ledger.recordOutcome({ run_id, score, fact_ids });

const report = await evaluateRetention(store, ledger, {
  min_trials: 3,
  promote_margin: 0.05,
  evict_margin: 0.05,
  max_baseline_runs: 40,
});

const lessons = await retrieveGatedLessons(store, {
  tags: ['lesson', 'graph:my-graph-v1'],
  max_facts: 10,
  candidate_slots: 4,
  rest_after_trials: 5,
  ledger,
});
```

The gate's default decision rule inference uses a Welch-style test with Benjamini–Hochberg FDR control and alpha-spending across doubling baseline brackets (so gating every run doesn't inflate false positives — the peeking problem). Every decision carries an evidence object. And because none of the guarantees are universal, the package ships its own validator.

`gateOperatingCharacteristics()` - drives the real pipeline with lessons of known effect and tells you the detection/false-positive rates for **your** policy in under a second — measured on the shipped defaults: ±0.3 effects decided 94–100%, null effects falsely decided 0–2%, sub-resolution effects retired rather than guessed.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).