---
title: Context Engine
description: Composable compression pipeline that optimizes every token before it reaches the LLM.
---

The **Context Engine** (`@mcai/context-engine`) is a framework-agnostic compression pipeline that reduces prompt token usage by 30-60% while preserving information quality. It operates as an optional layer between your data and the LLM, compressing memory payloads, deduplicating content, and pruning low-value tokens.

The engine is a standalone package with zero orchestrator dependencies. It works with any LLM framework or as the compression layer inside `@mcai/orchestrator` via the `contextCompressor` option.

## How it works

```
Input Segments (system, memory, tools, history, user)
  |  Cache-Aware Prefix Locking
  |  Memory Hierarchy Formatting
  |  Model-Aware Format Selection
  |  Format Compression (JSON -> compact)
  |  Exact Deduplication (hash-based)
  |  Fuzzy Deduplication (trigram similarity)
  |  Semantic Deduplication (embedding-based)
  |  CoT Distillation (reasoning trace eviction)
  |  Self-Information Pruning (surprisal-based)
  |  Heuristic Pruning (rule-based)
  |  Budget Allocation (priority-weighted)
Output Segments (compressed, within token budget)
```

Each stage is independent and composable. Use the full pipeline, a single stage, or the optimizer presets.

## Segments

All content enters the pipeline as **segments** — typed chunks with a role, priority, and optional lock:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique segment identifier |
| `content` | `string` | The text content to compress |
| `role` | `SegmentRole` | `'system'`, `'memory'`, `'tools'`, `'history'`, `'user'`, or `'custom'` |
| `priority` | `number` | Higher priority segments get more of the token budget (default: 1) |
| `locked` | `boolean` | Locked segments bypass all compression stages (default: false) |

## Pipeline presets

The optimizer provides three presets that compose the right stages automatically:

| Preset | Stages | Typical Latency | Reduction |
|--------|--------|----------------|-----------|
| `fast` | Format + exact dedup + allocator | 2-5ms | 15-25% |
| `balanced` | Fast + fuzzy dedup + heuristic + CoT distillation | 10-20ms | 30-45% |
| `maximum` | Balanced + hierarchy/graph formatters + format selector | 50-200ms | 40-60% |

```typescript
import { createOptimizedPipeline } from '@mcai/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const result = pipeline.compress({
  segments: [
    { id: 'system', content: 'You are a helpful assistant.', role: 'system', priority: 10, locked: true },
    { id: 'memory', content: JSON.stringify(memoryData, null, 2), role: 'memory', priority: 5 },
    { id: 'history', content: chatHistory, role: 'history', priority: 3 },
  ],
  budget: { maxTokens: 4096, outputReserve: 1024 },
  model: 'claude-sonnet-4-20250514',
});

console.log(`${result.metrics.reductionPercent.toFixed(1)}% reduction`);
```

## Incremental pipeline

For multi-turn workflows, the incremental pipeline caches compressed output for unchanged segments between turns. Only segments whose content hash has changed are re-compressed.

```typescript
import { createIncrementalPipeline, createFormatStage } from '@mcai/context-engine';

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

Stages with `scope: 'cross-segment'` (like fuzzy dedup) are re-run only when per-segment stage **outputs** actually change — not just when inputs change. The pipeline tracks per-segment output hashes between turns: if a segment's input changes but its compressed output is identical to the previous turn, cross-segment stages are skipped entirely. Per-segment stages (the default) cache independently.

## Scoring and pruning

The engine provides multiple token importance scorers, from statistical to ML-backed:

### N-gram surprisal (zero dependencies)

Estimates self-information via character trigram frequency. Rare tokens in the corpus score higher. No external provider needed.

```typescript
import { createNGramScorer } from '@mcai/context-engine';

const scorer = createNGramScorer({ n: 3, granularity: 'sentence' });
```

### Heuristic scoring (rule-based)

Seven weighted dimensions: stop-word penalty, filler-phrase detection, position boost, frequency penalty, entity boost, structural markers, and query relevance.

```typescript
import { createHeuristicPruningStage } from '@mcai/context-engine';

const stage = createHeuristicPruningStage({
  queryWeight: 0.20, // boost tokens relevant to the user's query
});
```

When a `query` string is provided in the scorer context, tokens near query terms score higher. Without a query, the dimension is neutral.

### Neural scoring (optional)

For maximum compression quality, implement `CompressionProvider` against an inference server that returns per-token log-probabilities:

```typescript
import type { CompressionProvider } from '@mcai/context-engine';
import { precomputeImportanceScores } from '@mcai/context-engine';

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
import { createAdaptiveMemoryStage } from '@mcai/context-engine';

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

```typescript
import { allocateBudget, DefaultTokenCounter } from '@mcai/context-engine';

const counter = new DefaultTokenCounter();
const allocations = allocateBudget(segments, { maxTokens: 4096, outputReserve: 1024 }, counter);
```

### Cache diagnostics

Detect when prefix caching is being invalidated by dynamic segment content:

```typescript
import { diagnoseCacheStability, computeSegmentHashMap } from '@mcai/context-engine';

const previousHashes = computeSegmentHashMap(lastTurnSegments);
const diagnostics = diagnoseCacheStability(currentSegments, previousHashes);
// diagnostics.hitRate, diagnostics.unstableSegments, diagnostics.recommendations
```

### Circuit breaker

Wraps any stage and dynamically bypasses it when latency cost exceeds token savings:

```typescript
import { createCircuitBreaker, createLatencyTracker } from '@mcai/context-engine';

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
import { GraphRunner } from '@mcai/orchestrator';
import { createOptimizedPipeline, serialize } from '@mcai/context-engine';

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

Without a context compressor, the orchestrator falls back to `JSON.stringify` with a 128KB byte cap.

## Provider interfaces

The engine uses dependency injection for optional capabilities:

| Interface | Purpose | Built-in |
|-----------|---------|----------|
| `TokenCounter` | Count tokens per model | `DefaultTokenCounter` (character ratio estimates) |
| `CompressionProvider` | ML-based token importance | Implement against your inference server (Ollama, vLLM, etc.) |
| `EmbeddingProvider` | Vector embeddings for semantic dedup | (consumer-provided) |
| `SummarizationProvider` | LLM-based summarization | (consumer-provided) |

All providers are optional. Without them, the engine falls back to statistical methods (n-gram scoring, trigram dedup, heuristic pruning).

## Next steps

- [Workflow State](/concepts/workflow-state/) — how memory flows through the orchestrator
- [Memory System](/concepts/memory/) — hierarchical knowledge graph that feeds the context engine
- [Budget-Aware Model Selection](/guides/model-selection/) — how model choice affects compression
- [Using the Context Engine](/guides/context-engine/) — practical integration guide
