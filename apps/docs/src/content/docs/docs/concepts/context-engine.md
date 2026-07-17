---
title: Context Engine
description: Composable compression pipeline that optimizes every token before it reaches the LLM.
---

The **Context Engine** (`@cycgraph/context-engine`) is a framework-agnostic compression pipeline that reduces prompt token usage by 30-60% while preserving information quality. It operates as an optional layer between your data and the LLM, compressing memory payloads, deduplicating content, and pruning low-value tokens.

The engine is a standalone package with zero orchestrator dependencies. It works with any LLM framework or as the compression layer inside `@cycgraph/orchestrator` via the `contextCompressor` option.

## How it works

```
Input Segments (system, memory, tools, history, user)
  |  Cache-Aware Prefix Locking            (pre-processor)
  |  -- per-segment stages --
  |  Memory Hierarchy Formatting
  |  Model-Aware Format Selection
  |  Format Compression (JSON -> compact)
  |  CoT Distillation (reasoning trace eviction)
  |  -- cross-segment stages --
  |  Exact Deduplication (hash-based)
  |  Fuzzy Deduplication (trigram similarity)
  |  Semantic Deduplication (embedding-based)
  |  Self-Information Pruning (surprisal-based)
  |  Heuristic Pruning (rule-based)
  |  Budget Allocation (priority-weighted)
Output Segments (compressed, within token budget)
```

Each stage is independent and composable. Use the full pipeline, a single stage, or the optimizer presets. Stages are grouped by **scope**: per-segment stages transform each segment independently; cross-segment stages (dedup, pruning, allocation) depend on all segments at once. Keep per-segment stages first — the incremental pipeline executes the two groups as separate phases, and matching that order keeps batch and incremental output identical.

## Segments

All content enters the pipeline as **segments** — typed chunks with a role, priority, and optional lock:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique segment identifier |
| `content` | `string` | The text content to compress |
| `role` | `SegmentRole` | `'system'`, `'memory'`, `'tools'`, `'history'`, `'user'`, or `'custom'` |
| `priority` | `number` | Higher priority segments get more of the token budget (default: 1) |
| `locked` | `boolean` | Locked segments bypass all compression stages (default: false) |

Locked segments still occupy the context window: the pipeline charges their tokens against `budget.maxTokens` before stages run, so mutable segments are sized to what actually remains. When a `model` is supplied and its profile is known, the pipeline also warns (via the logger) if the budget exceeds the model's context window.

## Pipeline presets

The optimizer provides three presets that compose the right stages automatically:

| Preset | Stages | Typical Latency | Reduction |
|--------|--------|----------------|-----------|
| `fast` | Format + exact dedup + allocator | 2-5ms | 15-25% |
| `balanced` | Fast + CoT distillation + fuzzy dedup + heuristic pruning | 10-20ms | 30-45% |
| `maximum` | Balanced + hierarchy/graph formatters + format selector | 50-200ms | 40-60% |

In `maximum` with a `model` supplied, the format selector replaces the generic format stage — it serializes JSON per the model's capability profile (including compact JSON for small models), so the generic stage would only rewrite its output. The returned `stages` array exposes the composed stage objects for reuse with `createIncrementalPipeline`.

```typescript
import { createOptimizedPipeline } from '@cycgraph/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const result = pipeline.compress({
  segments: [
    { id: 'system', content: 'You are a helpful assistant.', role: 'system', priority: 10, locked: true },
    { id: 'memory', content: JSON.stringify(memoryData, null, 2), role: 'memory', priority: 5 },
    { id: 'history', content: chatHistory, role: 'history', priority: 3 },
  ],
  budget: { maxTokens: 4096, outputReserve: 1024 },
  model: 'claude-sonnet-4-6',
});

console.log(`${result.metrics.reductionPercent.toFixed(1)}% reduction`);
```

## Incremental pipeline

For multi-turn workflows, the incremental pipeline caches compressed output for unchanged segments between turns. Only segments whose hash has changed are re-compressed. The hash covers every cache-relevant field — `content`, `priority`, `locked`, and `metadata` — and the whole cache is invalidated if the budget or model changes between turns.

```typescript
import { createIncrementalPipeline, createFormatStage } from '@cycgraph/context-engine';

const pipeline = createIncrementalPipeline({
  stages: [createFormatStage()],
  enableCaching: true,
});

// Turn 1 — all segments compressed
const turn1 = pipeline.compress({ segments, budget });

// Turn 2 — only changed segments re-compressed
const turn2 = pipeline.compress(
  { segments: updatedSegments, budget },
  turn1.state,
);

console.log(`Cached: ${turn2.cachedSegmentCount}, Fresh: ${turn2.freshSegmentCount}`);
```

Cross-segment stages (like fuzzy dedup) are re-run only when per-segment stage **outputs** actually change — not just when inputs change. The pipeline tracks per-segment output hashes between turns: if a segment's input changes but its compressed output is identical to the previous turn, cross-segment stages are skipped entirely.

Scope is a declaration each stage makes:

- **Undeclared scope defaults to `'cross-segment'`** — the safe assumption. The stage always sees all segments; it just doesn't get per-segment caching.
- Declare `scope: 'per-segment'` only when each segment's output depends solely on that segment's own content. This opts the stage into independent caching. A stage with any state spanning segments (a `seen` set, budget shares, corpus statistics) must not declare it.
- Stages run in two phases: all per-segment stages, then all cross-segment stages. A config that interleaves them (a per-segment stage after a cross-segment one) executes in a different order than the batch pipeline would — the incremental pipeline logs a warning at construction when it detects this. Order per-segment stages first.

## Scoring and pruning

The engine provides multiple token importance scorers, from statistical to ML-backed:

### N-gram surprisal (zero dependencies)

Estimates self-information via character trigram frequency. Rare tokens in the corpus score higher. No external provider needed.

```typescript
import { createNGramScorer } from '@cycgraph/context-engine';

const scorer = createNGramScorer({ n: 3, granularity: 'sentence' });
```

### Heuristic scoring (rule-based)

Seven weighted dimensions: stop-word penalty, filler-phrase detection, position boost, frequency penalty, entity boost, structural markers, and query relevance.

```typescript
import { createHeuristicPruningStage } from '@cycgraph/context-engine';

const stage = createHeuristicPruningStage({
  queryWeight: 0.20, // boost tokens relevant to the user's query
});
```

When a `query` string is provided in the scorer context, tokens near query terms score higher. Without a query, the dimension is neutral.

### Neural scoring (optional)

For maximum compression quality, implement `CompressionProvider` against an inference server that returns per-token log-probabilities:

```typescript
import type { CompressionProvider } from '@cycgraph/context-engine';
import { precomputeImportanceScores } from '@cycgraph/context-engine';

// Implement against your inference server (Ollama, vLLM, TGI, etc.)
const provider: CompressionProvider = {
  async scoreTokenImportance(tokens, context) {
    const text = (context ? context + ' ' : '') + tokens.join(' ');
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'distilgpt2', prompt: text, raw: true }),
    });
    // Extract and normalize per-token log-probs to [0,1]
    // Higher surprisal = more important to retain
    return tokens.map(() => 0.5); // replace with actual implementation
  },
};

const scores = await precomputeImportanceScores(segments, provider);
```

Without a `CompressionProvider`, the self-information stage falls back to the n-gram surprisal scorer (zero dependencies, pure TypeScript). This covers most use cases without any external infrastructure.

## Adaptive memory compression

The adaptive memory stage intelligently prioritizes memory content based on hierarchy signals:

```typescript
import { createAdaptiveMemoryStage } from '@cycgraph/context-engine';

const stage = createAdaptiveMemoryStage({
  recencyBoostDays: 7,     // facts within 7 days get 2x priority
  recencyMultiplier: 2.0,
  maxFactsPerTheme: 10,    // truncate to 10 facts per theme
});
```

This stage operates on segments with `role: 'memory'` containing JSON memory payloads. Facts from larger themes (more members) and recent facts get higher priority. Non-memory segments pass through unchanged.

## Budget management

### Token allocation

The budget allocator distributes tokens across segments by priority weight. Locked segments get their exact token count; remaining budget is split proportionally among mutable segments.

Enforcement is **importance-aware for prose**: an over-budget segment keeps its most important tokens (entities, quantities, protected negations) in original order rather than its earliest ones — position-based tail truncation would delete trailing facts while keeping leading filler. Structured segments (memory/tools roles, JSON) always tail-truncate cleanly instead, since token pruning would corrupt them. Pass `truncation: 'tail'` to `createAllocatorStage` for the legacy prefix-keeping behavior, or `scorer` to swap the importance model.

```typescript
import { allocateBudget, DefaultTokenCounter } from '@cycgraph/context-engine';

const counter = new DefaultTokenCounter();
const allocations = allocateBudget(segments, { maxTokens: 4096, outputReserve: 1024 }, counter);
```

### Relevance allocation (query-aware)

The allocator has a second allocation mode, `allocation: 'relevance'`, which the presets use by default. When the `compress()` input carries a `query` (the question or goal the context will serve), segments are ranked by BM25 relevance to the query — with light stemming and iterated pseudo-relevance feedback (default 2 rounds, tunable via the allocator's `relevance` option) so multi-hop bridging documents rank too — and budget is granted **whole-segment greedily** in relevance order: the most relevant segments are kept intact, the least relevant are starved. Within-segment condensing stays query-agnostic (entity-driven), because query-similar tokens are not the same as answer-bearing tokens.

Without a `query` — or when no segment matches it — relevance mode is byte-identical to proportional allocation, so passing no query is always safe.

```typescript
const result = pipeline.compress({
  segments,
  budget: { maxTokens: 4096, outputReserve: 0 },
  query: 'Where is Northgate Holdings headquartered?',
});
```

On two public benchmarks (both n=100, matched budgets, paired deltas significant), relevance allocation at a 0.3 compression target retained 67/82 answerable questions versus 51/82 for LLMLingua-2 on HotpotQA, and 23/47 versus 13/47 on multi-hop MuSiQue — at ~4ms versus ~600-950ms per compression. In an agent workflow the orchestrator passes the sanitized workflow goal as the query automatically.

### Cache-aware locking

`applyCachePolicy` marks system/tools segments as `locked` before compression so provider prompt caches see byte-identical prefixes. Pass the target `model` and the policy consults its profile: providers without a prompt cache (`supportsCaching: false`) get no locks added — locking trades compression for cache stability, which buys nothing without a cache. Pre-existing locks are always preserved.

```typescript
import { applyCachePolicy } from '@cycgraph/context-engine';

const locked = applyCachePolicy(segments, { model: 'claude-sonnet-4-6' });
const result = pipeline.compress({ segments: locked, budget });
```

### Cache diagnostics

Detect when prefix caching is being invalidated by dynamic segment content:

```typescript
import { diagnoseCacheStability, computeSegmentHashMap } from '@cycgraph/context-engine';

const previousHashes = computeSegmentHashMap(lastTurnSegments);
const diagnostics = diagnoseCacheStability(currentSegments, previousHashes);
// diagnostics.hitRate, diagnostics.unstableSegments, diagnostics.recommendations
```

Two cross-turn measures are available. `measureCacheHitRate` is set-based — the fraction of locked content that is byte-identical, ignoring position (an upper bound). `measurePrefixStability` is prefix-faithful: a change or reorder at position *k* counts everything after *k* as invalidated, matching how provider prompt caches actually behave.

```typescript
import { computePrefixHashList, measurePrefixStability } from '@cycgraph/context-engine';

const stability = measurePrefixStability(
  computePrefixHashList(currentSegments),
  computePrefixHashList(lastTurnSegments),
);
```

### Circuit breaker

Wraps any stage and dynamically bypasses it when latency cost exceeds token savings:

```typescript
import { createCircuitBreaker, createLatencyTracker } from '@cycgraph/context-engine';

const tracker = createLatencyTracker();
const guarded = createCircuitBreaker(expensiveStage, tracker, {
  minEfficiency: 1.0,    // tokens saved per millisecond
  warmupSamples: 5,
  cooldownMs: 30_000,
});
```

## Pipeline configuration

### Logger

All pipelines accept an optional `PipelineLogger` for structured diagnostic output:

```typescript
const pipeline = createPipeline({
  stages: [...],
  logger: {
    debug: (msg) => myLogger.debug(msg),
    warn: (msg) => myLogger.warn(msg),
  },
});
```

Stage errors and timeout warnings are routed through the logger instead of being silently swallowed.

The logger is also threaded into every stage via `StageContext.logger`, so stage-level diagnostics (e.g. dedup item caps) land in the same place. Must-see warnings fall back to `console.warn` when no logger is configured.

### Debug source maps

With `debug: true`, the result includes per-segment provenance:

```typescript
const pipeline = createPipeline({ stages: [...], debug: true });
const result = pipeline.compress({ segments, budget });

for (const entry of result.sourceMap ?? []) {
  // entry.original / entry.compressed — content before and after
  // entry.changedBy — stages that modified this segment, in order
  // entry.removed / entry.removedBy — set if a stage dropped the segment
  // entry.addedBy — set if a stage introduced the segment
  // entry.fromCache — incremental pipeline: provenance computed on an earlier turn
}
```

Provenance is segment-level (whole-content snapshots with stage attribution), not token-level. The incremental pipeline threads it across cached turns, so a fully-cached turn still reports how its output was derived.

### Pipeline timeout

A pipeline-level timeout skips remaining stages when the wall-clock budget is exceeded:

```typescript
const pipeline = createPipeline({
  stages: [...],
  timeoutMs: 200,  // skip remaining stages after 200ms
});
```

This is a stage-boundary check (the pipeline is synchronous by design). For async precompute steps like `precomputeEmbeddings`, use `Promise.race` externally.

## Deduplication performance

Fuzzy and semantic dedup use **locality-sensitive hashing** (LSH) to avoid O(n²) pairwise comparisons on large inputs:

| Stage | Algorithm | Pre-filter | Threshold |
|-------|-----------|-----------|-----------|
| Fuzzy dedup | Trigram Jaccard | MinHash LSH (100 hashes, 20 bands) | Items > 200 |
| Semantic dedup | Cosine similarity | SimHash LSH (64 bits, 16 bands) | Items > 200 |

For inputs ≤ 200, the original O(n²) path is used (LSH overhead isn't worthwhile). The default `maxItems` cap is 2000 (up from 500 before LSH).

## Orchestrator integration

Inject the context engine into `GraphRunner` via the `contextCompressor` option:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, serialize } from '@cycgraph/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{ id: 'memory', content: serialize(sanitizedMemory), role: 'memory', priority: 1 }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
    model: options?.model,
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { contextCompressor });
```

Without a context compressor, the orchestrator falls back to `JSON.stringify` with a 50KB byte cap.

## Provider interfaces

The engine uses dependency injection for optional capabilities:

| Interface | Purpose | Built-in |
|-----------|---------|----------|
| `TokenCounter` | Count tokens per model | `DefaultTokenCounter` (character ratio estimates); `createTiktokenCounter(encode)` wraps a BPE encoder with LRU memoization for exact counts |
| `CompressionProvider` | ML-based token importance | Implement against your inference server (Ollama, vLLM, etc.) |
| `EmbeddingProvider` | Vector embeddings for semantic dedup | (consumer-provided) |
| `SummarizationProvider` | LLM-based summarization | (consumer-provided) |

All providers are optional. Without them, the engine falls back to statistical methods (n-gram scoring, trigram dedup, heuristic pruning).

## Next steps

- [Workflow State](/docs/concepts/workflow-state/) — how memory flows through the orchestrator
- [Memory System](/docs/concepts/memory/) — hierarchical knowledge graph that feeds the context engine
- [Budget-Aware Model Selection](/docs/guides/model-selection/) — how model choice affects compression
- [Using the Context Engine](/docs/guides/context-engine/) — practical integration guide
