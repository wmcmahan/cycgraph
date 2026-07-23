---
title: Context Engine
description: Composable compression pipeline that optimizes every token before it reaches the LLM.
---

The context engine helps to reduce prompt token usage while preserving information quality. It operates as an optional layer between your data and the LLM, compressing memory payloads, deduplicating content, and pruning low-value tokens.

It works with any LLM framework but is built to be used with the orchestration graph.

```bash
npm install @cycgraph/context-engine
```

## How it works

The Context Engine is composed of compression stages, ordered by an invariant with cheap and lossless transforms first, redundancy removal second, lossy content selection third, and the budget allocator always last as the enforcement backstop. Everything before the allocator reduces tokens without a budget in hand. The allocator guarantees the output fits.

Each stage is independent and composable. Use the full pipeline, a single stage, or the optimizer presets. Stages are grouped by scope; per-segment stages transform each segment independently, cross-segment stages, such as dedup, pruning, and allocation, depend on all segments at once.

Per-segment stages execute first. The incremental pipeline executes the two groups as separate phases, and matching that order keeps batch and incremental output identical.

## Pipeline

The pipeline defines an ordered set of stages that are executed in order. You can use it directly or create your own custom pipeline that includes the stages you want.

### Presets

For ease of use, the engine provides the following presets that compose the right stages automatically. This can be useful for getting started quickly or for simple use cases. More complex use cases may benefit from creating a custom pipeline. The presets are ordered by performance, with fast being the fastest and maximum being the slowest — each preset adds more (and heavier) stages, and every stage adds execution time.

```typescript
const pipeline = createOptimizedPipeline({ preset: 'balanced' });
```

| Preset | Stages | Measured latency* |
|---|---|---|
| **fast** | format → exact dedup → allocator | ~10–14 ms |
| **balanced** | + CoT distillation, fuzzy dedup, heuristic pruning | ~16–28 ms |
| **maximum** | + hierarchy/graph formatters, model-aware format selection | ~16–29 ms |

\* Mean per-compression latency on the benchmark's 1–5k-token, 10–20-document payloads; small payloads run in low single-digit milliseconds. `maximum` matches `balanced` here because its extra stages no-op on plain prose.

### Custom

For more fine-grained control over the compression process, you can create a custom pipeline by composing stages yourself. You can also create your own [stages](#stages). 

**Note:** When creating a custom pipeline, you should always place per-segment stages before cross-segment stages. This ensures that the incremental pipeline produces the same output as the batch pipeline.

```typescript
import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createHeuristicPruningStage,
  createAllocatorStage,
} from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [
    createFormatStage(),            // per-segment
    createExactDedupStage(),        // cross-segment
    createHeuristicPruningStage(),  // cross-segment
    createAllocatorStage(),         // cross-segment, always last
  ],
});
```

Each factory returns a complete [`Stage`](#stage) — `name` and `scope` are declared by the stage itself, not wrapped by the caller.

### Incremental

For multi-turn workflows, the incremental pipeline caches compressed output for unchanged segments between turns. Only segments that have changed are re-compressed.

Cross-segment stages, such as fuzzy dedup, are re-run only when per-segment stage outputs actually change, not just when inputs change. The pipeline tracks per-segment output hashes between turns: if a segment's input changes but its compressed output is identical to the previous turn, cross-segment stages are skipped entirely.

Undeclared scope defaults to `cross-segment`. The stage always sees all segments, but doesn't get per-segment caching. Declare `per-segment` only when each segment's output depends solely on that segment's own content. This opts the stage into independent caching. A stage with any state spanning segments must not declare it.

Stages run in two phases: all per-segment stages, then all cross-segment stages. A config that interleaves them, such as a per-segment stage after a cross-segment one, executes in a different order than the batch pipeline, and the incremental pipeline logs a warning at construction when it detects this. Order per-segment stages first.

```typescript
import {
  createIncrementalPipeline,
  createFormatStage,
  createExactDedupStage,
  createHeuristicPruningStage,
  createAllocatorStage,
} from '@cycgraph/context-engine';

const pipeline = createIncrementalPipeline({
  enableCaching: true,
  stages: [
    createFormatStage(),
    createExactDedupStage(),
    createHeuristicPruningStage(),
    createAllocatorStage(),
  ],
});
```

**Refs:**
- [createIncrementalPipeline](#createincrementalpipeline): Creates an incremental pipeline that reuses cached compressed output for segments whose hash is unchanged; cross-segment stages re-run only when some per-segment *output* actually changed.

### Logger

The pipeline accepts a logger and forwards it to each stage via the stage context; every message a stage emits is passed straight through. The pipeline also logs its own messages for stage configuration warnings (e.g. interleaved scopes), budget-vs-context-window sanity checks, and timeout events.

```typescript
const pipeline = createPipeline({
  stages: [...],
  logger: {
    debug: (msg) => myLogger.debug(msg),
    warn: (msg) => myLogger.warn(msg),
  },
});
```

**Refs:**
- [PipelineLogger](#logger): Interface for logging.

### Source maps

The pipeline can generate source maps that track changes to segments throughout the pipeline. This is useful for debugging and for understanding how the pipeline is transforming the input segments. The source map is a segment-level provenance, not token-level, and is threaded through the incremental pipeline across cached turns.

```typescript
const pipeline = createPipeline({ stages: [...], debug: true });
const result = pipeline.compress({ segments, budget });
```

**Refs:**
- [SourceMap](#source-map): Interface for source maps.

### Pipeline timeout

A pipeline-level timeout skips remaining stages when the time budget is exceeded. The pipeline is synchronous by design, so this is a simple check before each stage starts: stages that already completed keep their results, and once the elapsed time exceeds `timeoutMs` every remaining stage is skipped. The pipeline logs a warning naming the first skipped stage. Because the allocator is typically the last stage, a very tight timeout can skip budget enforcement itself — size `timeoutMs` to comfortably include it.

```typescript
const pipeline = createPipeline({
  stages: [...],
  timeoutMs: 200,
});
```

## Stages

A stage is a function that takes as input the current set of segments and returns a new set of segments, with access to the budget, token counter, and query context. Cross-segment stages always see all segments; per-segment stages may be run on a subset (the incremental pipeline runs them on changed segments only). The pipeline is synchronous by design, so each stage is executed in order and the pipeline will wait for each stage to complete before moving to the next stage.

### Format

Format stages handle formatting for target LLMs. 

```typescript
import { createFormatStage } from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [createFormatStage({ forceShape: 'tabular' })],
});

```

**Refs:**
- [createFormatStage](#createformatstage): Detects the shape of the input data and formats it accordingly.
- [createFormatSelectorStage](#createformatselectorstage): Model-aware format selection: consults the target model’s capability profile (tabular support, JSON preference) and serializes accordingly. When active, omit the generic format stage — it would rewrite the model-aware choice.
- [createCommunityFormatterStage](#createcommunityformatterstage): Formats GraphRAG-style community summaries into weight-sorted rollups.
- [createHierarchyFormatterStage](#createhierarchyformatterstage): Formats xMemory-style hierarchy payloads into a compact text representation.
- [createGraphSerializerStage](#creategraphserializerstage): Serializes knowledge-graph payloads (entities + relationships) — per-type tables when uniform, lossless adjacency lists otherwise.

### Deduplication

Deduplication stages remove redundant content from the context. They operate on the entire set of segments, and must declare a scope of 'cross-segment'.

```typescript
import { createExactDedupStage, createFuzzyDedupStage } from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [createExactDedupStage(), createFuzzyDedupStage()],
});
```

##### Deduplication performance

Fuzzy and semantic dedup use **locality-sensitive hashing** (LSH) to avoid O(n²) pairwise comparisons on large inputs:

| Stage | Algorithm | Pre-filter | LSH engages |
|-------|-----------|-----------|-----------|
| Fuzzy dedup | Trigram Jaccard | MinHash LSH (100 hashes, 20 bands) | Items > 200 |
| Semantic dedup | Cosine similarity | SimHash LSH (64 bits, 16 bands) | Items > 200 |

For inputs ≤ 200, the direct O(n²) path is used (LSH overhead isn't worthwhile). The default `maxItems` cap is 2000; items beyond it pass through undeduped.

**Refs:**
- [createExactDedupStage](#createexactdedupstage): Removes exact duplicate content (FNV-1a content hashing).
- [createFuzzyDedupStage](#createfuzzydedupstage): Removes near-duplicates via character-trigram Jaccard similarity (default threshold 0.85).
- [createSemanticDedupStage](#createsemanticdedupstage): Removes paraphrased duplicates via embedding cosine similarity (default threshold 0.90). Requires an embedding provider and the async [`precomputeEmbeddings`](#precomputeembeddings) step; not included in any preset.

### Adaptive memory

The adaptive memory stage operates on segments with the role `memory` containing JSON memory payloads. It intelligently prioritizes memory content based on hierarchy signals. Facts from larger themes and recent facts get higher priority. Non-memory segments pass through unchanged.

```typescript
import {
  createAdaptiveMemoryStage,
  createPipeline
} from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [
    createAdaptiveMemoryStage({
      recencyBoostDays: 7,
      maxFactsPerTheme: 10,
    }),
  ],
});
```

### Chain-of-Thought

Detects reasoning blocks between delimiter pairs (filtered to the target model's family, e.g. `<thinking>…</thinking>`) and replaces each block with its extracted conclusion — located by explicit markers like `therefore:` / `final answer:`, or the block's final paragraph. Blocks are scanned left to right; an unclosed delimiter is skipped rather than risking content corruption.

```typescript
import { createCotDistillationStage } from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [createCotDistillationStage()],
});
```

**Refs:**
- [createCotDistillationStage](#createcotdistillationstage): Replaces delimited reasoning blocks with their extracted conclusions.

### Scoring and pruning

The engine provides multiple token importance scorers, from statistical to ML-backed. 

#### N-gram surprisal

Estimates self-information via character trigram frequency. Rare tokens in the corpus score higher. No external provider needed.

```typescript
import { createNGramScorer, createPruningStage, createPipeline } from '@cycgraph/context-engine';

const scorer = createNGramScorer({ n: 3, granularity: 'sentence' });

const pipeline = createPipeline({
  stages: [createPruningStage(scorer)],
});
```

No pre-computation step is needed — the n-gram scorer is synchronous and runs inline. (`precomputeImportanceScores` is for provider-backed neural scoring; see below.)

### Heuristic scoring

Seven weighted dimensions: stop-word penalty, filler-phrase detection, position boost, frequency penalty, entity boost, structural markers, and query relevance.

```typescript
import { createHeuristicPruningStage } from '@cycgraph/context-engine';

const stage = createHeuristicPruningStage({
  queryWeight: 0.20,
});
```

When a `query` string is provided in the scorer context, tokens near query terms score higher. Without a query, the dimension is neutral.

### Neural scoring (optional)

For maximum compression quality, implement [`CompressionProvider`](#compressionprovider) against an inference server that returns per-token log-probabilities. 

```typescript
import type { CompressionProvider } from '@cycgraph/context-engine';
import { precomputeImportanceScores } from '@cycgraph/context-engine';

const provider: CompressionProvider = {
  async scoreTokenImportance(tokens, context) {
    const text = (context ? context + ' ' : '') + tokens.join(' ');
    const response = await fetch('http://your-inference-server', {
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

**Refs:**
- [createPruningStage](#createpruningstage): Score-and-prune with any [`TokenScorer`](#tokenscorer) — the generic building block.
- [createHeuristicPruningStage](#createheuristicpruningstage): Pruning with the rule-based heuristic scorer (the `balanced`/`maximum` preset stage). Best on verbose, redundant prose; measurably hurts extractive QA on dense factual content.
- [createSelfInformationStage](#createselfinformationstage): Surprisal-based pruning from provider scores, with n-gram fallback; not included in any preset.

Scorers are also exported standalone — [`createNGramScorer`](#createngramscorer), [`createHeuristicScorer`](#createheuristicscorer), [`createSelfInformationScorer`](#createselfinformationscorer) — for use with `createPruningStage` or the allocator's `scorer` option.

### Budget allocation

The allocator is a stage like any other — always place it last. It distributes the token budget across segments (proportionally, or by query relevance in the presets) and condenses whichever segments exceed their share. Configuration and the standalone `allocateBudget` are covered in [Budget management](#budget-management).

```typescript
import { createAllocatorStage } from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [createFormatStage(), createExactDedupStage(), createAllocatorStage()],
});
```

**Refs:**
- [createAllocatorStage](#createallocatorstage): Budget enforcement — proportional or relevance allocation, importance-aware condensing.

### Stage wrappers

- [createCircuitBreaker](#createcircuitbreaker): Wraps any expensive stage and bypasses it (with cooldown retry) when its tokens-saved-per-millisecond falls below a floor. Propagates the wrapped stage's `scope`. See [Circuit breaker](#circuit-breaker).

## Budget management

### Token allocation

The budget allocator distributes tokens across segments by priority weight. Locked segments get their exact token count; remaining budget is split proportionally among mutable segments.

Enforcement is **importance-aware for prose**: an over-budget segment keeps its most important tokens (entities, quantities, protected negations) in original order rather than its earliest ones — position-based tail truncation would delete trailing facts while keeping leading filler. Structured segments (memory/tools roles, JSON) always tail-truncate cleanly instead, since token pruning would corrupt them. Pass `truncation: 'tail'` to `createAllocatorStage` for the legacy prefix-keeping behavior, or `scorer` to swap the importance model.

```typescript
import { allocateBudget, createAllocatorStage, DefaultTokenCounter } from '@cycgraph/context-engine';

// Standalone: inspect how the budget would be distributed
const counter = new DefaultTokenCounter();
const { allocations, overflow } = allocateBudget(
  segments,
  { maxTokens: 4096, outputReserve: 1024 },
  counter,
);

// In a pipeline: the allocator stage does the same allocation, then condenses
const pipeline = createPipeline({
  stages: [createAllocatorStage()],
});
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

## API

### `createPipeline`

Use this when you want to apply some or all of the stages in the pipeline as a transformation on some input.

```typescript
createPipeline(config: PipelineConfig)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `stages` | `Stage[]` | `[]` | Ordered list of compression stages to use. |
| `timeoutMs` | `number` | `undefined` | Pipeline timeout in milliseconds. |
| `tokenCounter` | [`TokenCounter`](#tokencounter) | `DefaultTokenCounter` | The token counter to use for the pipeline (default: character-ratio approximation; use `createTiktokenCounter` for exact BPE counts). |
| `debug` | `boolean` | `false` | Enable debug source maps. |
| `logger` | [`PipelineLogger`](#logger) | `undefined` | Logger for pipeline events. |

#### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `compress` | [`PipelineCompress`](#compress) | The compress function. |

### `createOptimizedPipeline`

Use this when you want to compress a set of segments as-is (e.g. you're about to pass them to an LLM).

```typescript
createOptimizedPipeline(options?: OptimizerOptions | undefined)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | `undefined` | Target model for model-aware format selection. |
| `preset` | `fast` \| `balanced` \| `maximum` | `balanced` | The preset to use for the pipeline. |
| `maxLatencyMs` | `number` | `undefined` | Auto-select preset based on latency budget in milliseconds. |
| `tokenCounter` | [`TokenCounter`](#tokencounter) | `DefaultTokenCounter` | The token counter to use for the pipeline (default: character-ratio approximation; use `createTiktokenCounter` for exact BPE counts). |
| `debug` | `boolean` | `false` | Enable debug source maps. |
| `logger` | [`PipelineLogger`](#logger) | `undefined` | Logger for pipeline events. |
| `timeoutMs` | `number` | `undefined` | Pipeline timeout in milliseconds. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `compress` | [`PipelineCompress`](#compress) | The compress function. |
| `preset` | `fast` \| `balanced` \| `maximum` | The preset that was selected. |
| `stageNames` | `string[]` | Names of the composed stages, in order. |
| `stages` | [`Stage[]`](#stage) | The stage objects (e.g. for reuse with `createIncrementalPipeline`). |
| `pipeline` | `OptimizedPipeline` | **Deprecated.** Self-reference kept for the old `const { pipeline } = ...` call sites; removed in the next major. |


### `createIncrementalPipeline`

For multi-turn workflows, the incremental pipeline caches compressed output for unchanged segments between turns. Only segments that have changed since the last call are re-compressed. The cache is invalidated if the budget, model, or query changes between turns.

```typescript
createIncrementalPipeline(config: IncrementalPipelineConfig)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `stages` | [`Stage`](#stage) | `[]` | Ordered list of compression stages to use. |
| `timeoutMs` | `number` | `undefined` | Pipeline timeout in milliseconds. |
| `tokenCounter` | [`TokenCounter`](#tokencounter) | `DefaultTokenCounter` | The token counter to use for the pipeline (default: character-ratio approximation; use `createTiktokenCounter` for exact BPE counts). |
| `debug` | `boolean` | `false` | Enable debug source maps. |
| `logger` | [`PipelineLogger`](#logger) | `undefined` | Logger for pipeline events. |
| `enableCaching` | `boolean` | `true` | Enable caching between turns. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `compress` | `(input: PipelineInput, state?: PipelineState) => IncrementalResult` | The compress function. Pass the previous turn's `state` to reuse cached segments; returns an [`IncrementalResult`](#incrementalresult). |

### `compress`

```typescript
compress(input: PipelineInput)
```

##### Input

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `segments` | [`PromptSegment`](#prompt-segment) | required | Ordered list of segments to compress. |
| `budget` | [`BudgetConfig`](#budget) | required | Budget for the pipeline. |
| `query` | `string` | `undefined` | The task/question this context will serve. Activates query-aware stages (relevance allocation, query-weighted scoring). |
| `model` | `string` | `undefined` | Target model for model-aware format selection. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `segments` | [`PromptSegment`](#prompt-segment) | The compressed segments. |
| `metrics` | [`PipelineMetrics`](#pipelinemetrics) | Metrics for the pipeline. |
| `sourceMap` | [`SourceMapEntry[]`](#source-map) | Source map for the pipeline. |

### createNGramScorer

```typescript
createNGramScorer(options?: NGramScorerOptions)
```

##### Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | `3` | The n-gram size (character trigrams by default). |
| `smoothing` | `number` | `1` | Laplace smoothing factor. |
| `granularity` | `"token"` \| `"sentence"` | `"token"` | Scoring granularity. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `scorer` | [`TokenScorer`](#tokenscorer) | Surprisal-based scorer: rare n-grams score high, formulaic text scores low. |

### `precomputeImportanceScores`

```typescript
precomputeImportanceScores(segments: PromptSegment[], provider: CompressionProvider, options?: { granularity?: Granularity, query?: string }): Promise<Map<string, ScoredToken[]>>
```

Async pre-computation for [`createSelfInformationStage`](#createselfinformationstage) — call before the synchronous `compress()` and pass the result as `precomputed`.

##### Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `granularity` | `"token"` \| `"sentence"` | `"sentence"` | Scoring granularity. |
| `query` | `string` | `undefined` | Query for contrastive scoring. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `scores` | `Map<string, ScoredToken[]>` | Importance scores keyed by segment content, ready for `SelfInformationOptions.precomputed`. |

### `createFormatStage`

Lossless format compression: detects the shape of JSON payloads (uniform arrays → tabular, flat objects → compact JSON, ragged → nested) and re-serializes compactly.

```typescript
createFormatStage(options?: FormatOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `forceShape` | `"tabular"` \| `"flat-object"` \| `"nested"` \| `"prose"` \| `"mixed"` | auto-detect | Force a specific serialization strategy instead of auto-detecting. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (per-segment). |

### `createFormatSelectorStage`

Model-aware format selection: consults the target model's capability profile (tabular support, JSON preference) and serializes accordingly. When active, omit the generic format stage — it would rewrite the model-aware choice.

```typescript
createFormatSelectorStage(options?: FormatSelectorOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `customProfiles` | `Record<string, ModelProfile>` | `undefined` | Custom model profiles, matched by prefix before the built-ins. |
| `forceJson` | `boolean` | `false` | Force JSON output regardless of model. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createExactDedupStage`

Removes exact duplicate content via FNV-1a content hashing. Skips structured segments (near-identical records are data, not redundancy).

```typescript
createExactDedupStage()
```

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (cross-segment). |

### `createFuzzyDedupStage`

Near-duplicate removal via character-trigram Jaccard similarity. Skips structured segments.

```typescript
createFuzzyDedupStage(options?: FuzzyDedupOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `threshold` | `number` | `0.85` | Jaccard similarity threshold (0–1). |
| `minLength` | `number` | `20` | Minimum character length for comparison. |
| `maxItems` | `number` | `2000` | Maximum items to compare pairwise; items beyond the cap pass through undeduped. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (cross-segment). |

### `createSemanticDedupStage`

Paraphrase-duplicate removal via embedding cosine similarity. Requires an embedding provider; because `compress()` is synchronous, call [`precomputeEmbeddings`](#precomputeembeddings) before compressing (or pass `precomputed`). Not included in any preset.

```typescript
createSemanticDedupStage(options: SemanticDedupOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | [`EmbeddingProvider`](#embeddingprovider) | required | Embedding provider. |
| `threshold` | `number` | `0.90` | Cosine similarity threshold for duplicate detection. |
| `minLength` | `number` | `20` | Minimum character length for comparison. |
| `precomputed` | `Map<string, number[]>` | `undefined` | Pre-computed embeddings keyed by text content (enables sync execution). |
| `maxItems` | `number` | `2000` | Maximum items to compare. Over 200 items, SimHash LSH pre-filters candidate pairs to avoid O(n²). |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (cross-segment). |

### `createCotDistillationStage`

Detects reasoning blocks ("let me think step by step…") and keeps only their conclusions, located by explicit markers or the block's final paragraph.

```typescript
createCotDistillationStage(options?: CotDistillationOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `delimiters` | `ReasoningDelimiter[]` | `DEFAULT_DELIMITERS` | Custom reasoning-block delimiters. |
| `preserveConclusion` | `boolean` | `true` | Extract and preserve conclusions. |
| `charsPerToken` | `number` | `4` | Characters-per-token ratio for eviction estimates. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (per-segment). |

### `createHeuristicPruningStage`

Deletes low-importance tokens using the rule-based heuristic scorer. Best on verbose, redundant prose — measurably hurts extractive QA on dense factual content (see `BENCHMARKS.md` in the package).

```typescript
createHeuristicPruningStage(options?: HeuristicScorerOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `stopWordWeight` | `number` | `0.25` | Weight for stop-word penalty. |
| `fillerWeight` | `number` | `0.15` | Weight for redundant-phrasing penalty. |
| `positionWeight` | `number` | `0.15` | Weight for position boost (first and last 10% of a segment). |
| `frequencyWeight` | `number` | `0.20` | Weight for frequency penalty. |
| `entityWeight` | `number` | `0.15` | Weight for named-entity boost. |
| `structuralWeight` | `number` | `0.10` | Weight for structural-marker boost. |
| `queryWeight` | `number` | `0.20` | Weight for query relevance (active only when a query is present; base weights scale down to make room). |
| `customStopWords` | `string[]` | `undefined` | Additional stop words. |
| `customFillerPhrases` | `string[]` | `undefined` | Additional filler phrases. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (cross-segment). |

### `createPruningStage`

Score-and-prune with a custom scorer — the generic version of `createHeuristicPruningStage`.

```typescript
createPruningStage(scorer: TokenScorer)
```

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createSelfInformationStage`

Surprisal-based pruning (Selective-Context-style). Requires pre-computed scores from a `CompressionProvider` (via [`precomputeImportanceScores`](#precomputeimportancescores)) or falls back to the n-gram scorer. Not included in any preset.

```typescript
createSelfInformationStage(options: SelfInformationOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | [`CompressionProvider`](#compressionprovider) | `undefined` | Provider for importance scoring (required for pre-computation). |
| `precomputed` | `Map<string, ScoredToken[]>` | `undefined` | Pre-computed scores keyed by segment content. |
| `query` | `string` | `undefined` | Query for contrastive scoring (LongLLMLingua-style). |
| `granularity` | `"token"` \| `"sentence"` | `"sentence"` | Scoring granularity. |
| `fallbackScorer` | [`TokenScorer`](#tokenscorer) | n-gram scorer | Fallback when precomputed scores are unavailable. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createAllocatorStage`

Budget enforcement — always the last stage. Distributes the budget across segments and condenses over-budget ones.

```typescript
createAllocatorStage(options?: AllocatorStageOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `allocation` | `"proportional"` \| `"relevance"` | `"proportional"` | Distribution strategy. `relevance` (used by the presets) ranks segments by BM25 relevance to the query and grants whole segments in rank order; falls back to proportional without a query. |
| `relevance` | [`RelevanceOptions`](#relevanceoptions) | measured defaults | Pseudo-relevance-feedback tuning for relevance mode. |
| `truncation` | `"importance"` \| `"tail"` | `"importance"` | How over-budget prose segments are cut: keep highest-scoring tokens in order, or keep the prefix. Structured segments always tail-truncate. |
| `scorer` | [`TokenScorer`](#tokenscorer) | heuristic scorer | Scorer for importance-aware truncation. |
| `truncationSuffix` | `string` | `"\n... [truncated]"` | Suffix appended to truncated segments. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage (cross-segment). |

### `createAdaptiveMemoryStage`

For hierarchical memory payloads (themes → facts): prioritizes facts by theme size and recency, truncates to `maxFactsPerTheme`, and re-serializes compactly. Non-memory segments pass through.

```typescript
createAdaptiveMemoryStage(options?: AdaptiveCompressionOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `recencyBoostDays` | `number` | `7` | Boost facts created within this many days. |
| `recencyMultiplier` | `number` | `2.0` | Recency multiplier for priority. |
| `maxFactsPerTheme` | `number` | `10` | Maximum facts to include per theme. |
| `minContentLength` | `number` | `undefined` | Minimum content length to process (shorter segments pass through). |
| `onShapeMismatch` | `(error, segmentId?) => void` | `undefined` | Callback when a memory segment fails schema validation. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createHierarchyFormatterStage`

Formats xMemory-style hierarchy payloads (themes, facts, episodes) into a compact text representation. Also available as the standalone `formatHierarchy(payload, options?)`.

```typescript
createHierarchyFormatterStage(options?: HierarchyFormatOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `includeMessages` | `boolean` | `false` | Include full message content for episodes (default: summaries). |
| `maxEpisodes` | `number` | `10` | Maximum episodes to include (most recent). |
| `maxFactsPerTheme` | `number` | `20` | Maximum facts per theme. |
| `dateFormat` | `"date"` \| `"datetime"` | `"date"` | Date rendering format. |
| `skipEmptyThemes` | `boolean` | `true` | Omit themes with zero matching facts. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createGraphSerializerStage`

Serializes knowledge-graph payloads (entities + relationships): per-type tables when every entity in a type group is uniform, lossless adjacency lists otherwise. Also available as the standalone `serializeGraph(entities, relationships, options?)`.

```typescript
createGraphSerializerStage(options?: GraphSerializerOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"tabular"` \| `"adjacency"` | auto | Force a serialization mode. |
| `includeInvalidated` | `boolean` | `false` | Include invalidated entities. |
| `includeExpired` | `boolean` | `false` | Include expired relationships. |
| `maxEntitiesPerType` | `number` | `50` | Maximum entities per type. |
| `maxRelationships` | `number` | `100` | Maximum relationships. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `createCommunityFormatterStage`

Formats GraphRAG-style community summaries into weight-sorted rollups. Also available as the standalone `formatCommunities(communities, options?)`.

```typescript
createCommunityFormatterStage(options?: CommunityFormatOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `maxCommunities` | `number` | `20` | Maximum communities to include. |
| `maxSummaryLength` | `number` | `500` | Maximum summary length in characters per community. |
| `sortByRelevance` | `boolean` | `true` | Sort by weight descending. |
| `maxLevel` | `number` | no filter | Only include communities at or below this level. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The composed stage. |

### `allocateBudget`

Standalone budget allocation (the allocator stage's core, without the condensing).

```typescript
allocateBudget(segments: PromptSegment[], budget: BudgetConfig, counter: TokenCounter, model?: string, options?: AllocateBudgetOptions): AllocationResult
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `query` | `string` | `undefined` | Query for relevance allocation (required for `allocation: "relevance"`). |
| `allocation` | `"proportional"` \| `"relevance"` | `"proportional"` | Distribution strategy. |
| `relevance` | [`RelevanceOptions`](#relevanceoptions) | measured defaults | PRF tuning for relevance mode. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `allocations` | `Map<string, number>` | Allocated tokens per segment (segment id → token budget). |
| `overflow` | `string[]` | Segment ids that exceed their allocation. |

### `scoreSegmentRelevance`

BM25 relevance ranking of segments against a query, with iterated pseudo-relevance feedback for multi-hop bridging.

```typescript
scoreSegmentRelevance(segments: PromptSegment[], query: string, options?: RelevanceOptions): Map<string, number>
```

##### Options

See [`RelevanceOptions`](#relevanceoptions).

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `scores` | `Map<string, number>` | Non-negative relevance score per segment id; segments matching neither the query nor the expansion score 0. Deterministic. |

### `applyCachePolicy`

Pre-processor (not a stage): marks qualifying segments as `locked` before compression so provider prompt caches see byte-identical prefixes across turns.

```typescript
applyCachePolicy(segments: PromptSegment[], options?: CachePolicyOptions): PromptSegment[]
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `lockSystem` | `boolean` | `true` | Lock segments with role `system`. |
| `lockTools` | `boolean` | `true` | Lock segments with role `tools`. |
| `lockFirstN` | `number` | `0` | Lock the first N segments regardless of role. |
| `lockPredicate` | `(segment) => boolean` | `undefined` | Custom predicate for additional locking rules. |
| `model` | `string` | `undefined` | Target model. If its profile has `supportsCaching: false`, no locks are added. Pre-existing locks are always preserved. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `segments` | [`PromptSegment[]`](#prompt-segment) | Segments with the policy's locks applied. |

### `diagnoseCacheStability`

Detects when dynamic content is invalidating provider prompt caches between turns.

```typescript
diagnoseCacheStability(currentSegments: PromptSegment[], previousHashes: Map<string, number>): CacheDiagnostics
```

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `hitRate` | `number` | Fraction of comparable segments with stable hashes (0–1). |
| `unstableSegments` | `{ id, hashPrevious, hashCurrent }[]` | Segments whose content changed between turns. |
| `recommendations` | `string[]` | Actionable recommendations for improving cache stability. |

### Cache-stability helpers

Position-sensitive stability measurement (like real provider prefix caches: a change at position *k* invalidates everything after it) plus the hash utilities that feed the diagnostics.

```typescript
computeSegmentHashMap(segments: PromptSegment[]): Map<string, number>
computePrefixHashList(segments: PromptSegment[]): number[]
measurePrefixStability(current: number[], previous: number[]): number   // 0–1, prefix-faithful
measureCacheHitRate(current: Set<number>, previous: Set<number>): number // 0–1, set-based upper bound
```

### `createCircuitBreaker`

Wraps an expensive stage; bypasses it (with a cooldown retry) when its tokens-saved-per-millisecond efficiency drops below a floor.

```typescript
createCircuitBreaker(stage: Stage, tracker: LatencyTracker, options?: CircuitBreakerOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `minEfficiency` | `number` | `1.0` | Minimum tokens saved per millisecond to keep the stage active. |
| `warmupSamples` | `number` | `5` | Run at least N times before considering bypass. |
| `cooldownMs` | `number` | `30000` | After bypassing, retry after this many milliseconds. |

##### Output

| Parameter | Type | Description |
|-----------|------|-------------|
| `stage` | [`Stage`](#stage) | The wrapped stage (propagates the inner stage's `scope`). |

### `createLatencyTracker`

Rolling latency/savings statistics consumed by the circuit breaker.

```typescript
createLatencyTracker(windowSize: number = 100): LatencyTracker
```

### `precomputeEmbeddings`

Async pre-computation for [`createSemanticDedupStage`](#createsemanticdedupstage) — call before the synchronous `compress()`. Structured segments are skipped (never semantically deduped, so never embedded).

```typescript
precomputeEmbeddings(segments: PromptSegment[], provider: EmbeddingProvider, minLength?: number): Promise<Map<string, number[]>>
```

### `serialize`

Standalone shape-detecting serializer (the format stage's core): any JSON-serializable value in, compact string out.

```typescript
serialize(data: unknown, options?: FormatOptions): string
```

### `distillCoT`

Standalone chain-of-thought distillation (the CoT stage's core).

```typescript
distillCoT(content: string, options?: CotDistillationOptions, model?: string): CotDistillationResult
```

### `pruneByScore`

Reconstructs text from scored tokens under a budget: protected tokens (negations) are kept unconditionally, then the highest-scoring tokens in original order.

```typescript
pruneByScore(tokens: ScoredToken[], maxTokens: number, counter: TokenCounter, model?: string): string
```

### `createHeuristicScorer`

The rule-based token scorer used by heuristic pruning and importance-aware truncation. Same options as [`createHeuristicPruningStage`](#createheuristicpruningstage).

```typescript
createHeuristicScorer(options?: HeuristicScorerOptions): TokenScorer
```

### `createSelfInformationScorer`

Surprisal-based scorer backed by precomputed provider scores, falling back to the n-gram scorer. Same options as [`createSelfInformationStage`](#createselfinformationstage).

```typescript
createSelfInformationScorer(options: SelfInformationOptions): TokenScorer
```

### `createTiktokenCounter`

Exact BPE token counting from a user-supplied encoder, with bounded memoization. The engine does not bundle a tokenizer — bring one (e.g. `gpt-tokenizer`).

```typescript
createTiktokenCounter(encode: (text: string) => number[], options?: { cacheSize?: number }): TokenCounter
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `cacheSize` | `number` | `512` | Max memoized texts (0 disables caching). |

### Low-level utilities

Exported building blocks for advanced composition; signatures in source.

| Export | Description |
|--------|-------------|
| `detectShape`, `serializeTabular`, `serializeFlatObject`, `serializeNested` | Format-stage internals: shape detection and the three serialization strategies. |
| `dedup`, `fuzzyDedup`, `trigramSet`, `jaccardSimilarity`, `fnv1a`, `simHashBuckets` | Dedup primitives: hash/similarity functions behind the dedup stages. |
| `createTokenCounter`, `countSegmentTokens`, `countTotalTokens`, `resolveTokenRatio`, `DefaultTokenCounter` | Token counting: default char-ratio counter and per-segment counting helpers. |
| `computeStageMetrics`, `aggregateMetrics`, `formatMetricsSummary` | Metrics helpers for custom reporting. |
| `resolveModelProfile`, `selectFormat`, `MODEL_PROFILES` | Model-profile lookup (prefix-matched) and format selection. |
| `SegmentRoleSchema`, `PromptSegmentSchema`, `BudgetConfigSchema` | Zod schemas for validating inputs at your own boundaries. |
| `NoopCompressionProvider`, `NoopEmbeddingProvider`, `NoopSummarizationProvider`, `noopLogger` | No-op provider/logger implementations for tests and defaults. |
| `DEFAULT_DELIMITERS` | Default reasoning-block delimiters for CoT distillation. |

## Interfaces

### Pipeline

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `compress` | [`PipelineCompress`](#compress) | `function` | The compress function. |

### Stage

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | `undefined` | Human-readable stage name (used in metrics). |
| `scope` | `"per-segment" \| "cross-segment"` | `undefined` | Whether this stage operates per-segment or across segments. |
| `execute` | `function` | `undefined` | Execute the compression stage on the given segments. |

### Prompt Segment

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | `undefined` | Unique identifier for this segment. |
| `content` | `string` | `undefined` | The text content of this segment. |
| `role` | `SegmentRole` | `undefined` | Semantic role of this segment in the prompt. |
| `priority` | `number` | `1` | Priority weight (higher = more important, gets more budget). |
| `locked` | `boolean` | `false` | If true, this segment bypasses all compression stages. |
| `metadata` | `Record<string, unknown>` | `undefined` | Arbitrary metadata (passed through stages unchanged). |

### Budget

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTokens` | `number` | `undefined` | Maximum total tokens for the compressed output. |
| `outputReserve` | `number` | `0` | Tokens reserved for model output generation. |
| `segmentBudgets` | `Record<string, number>` | `undefined` | Per-segment budget overrides (segment id → max tokens). |

### Logger

Optional logger for pipeline diagnostic output.

| Parameter | Type | Description |
|-----------|------|-------------|
| `warn` | `(message: string) => void` | Called for non-critical warnings. |
| `debug` | `(message: string) => void` | Called for debug information. |

### Source map

Used for pipeline diagnostics. Contains entries that map the original segment to the final segment. 

| Field | Type | Description |
|-------|------|-------------|
| `original` | `string` | The original content of the segment. |
| `compressed` | `string` | The compressed content of the segment. |
| `changedBy` | `string[]` | List of stages that changed the segment. |
| `removed` | `boolean` | Whether the segment was removed. |
| `removedBy` | `string` | The stage that removed the segment. |
| `fromCache` | `boolean` | Whether the segment was cached. |

### PipelineMetrics

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `totalTokensIn` | `number` | `undefined` | Total tokens in the original input. |
| `totalTokensOut` | `number` | `undefined` | Total tokens in the compressed output. |
| `overallRatio` | `number` | `undefined` | Overall compression ratio. |
| `reductionPercent` | `number` | `undefined` | Total reduction as a percentage (e.g. 45.2 = 45.2% reduction). |
| `totalDurationMs` | `number` | `undefined` | Total pipeline wall-clock time in milliseconds. |
| `stages` | [`StageMetrics`](#stagemetrics) | `undefined` | Per-stage breakdown. |
| `cached` | `boolean` | `undefined` | True when all segments were served from cache (no compression ran this turn). |

### StageMetrics

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | `undefined` | Stage name (same as `CompressionStage.name`). |
| `tokensIn` | `number` | `undefined` | Tokens before this stage ran. |
| `tokensOut` | `number` | `undefined` | Tokens after this stage ran. |
| `ratio` | `number` | `undefined` | Compression ratio (`tokensOut` / `tokensIn`). 1.0 = no change. |
| `durationMs` | `number` | `undefined` | Wall-clock time for this stage in milliseconds. |
| `error` | `boolean` | `undefined` | True when the stage encountered an error and passed through. |

### StageContext

Passed to every stage's `execute`. Built by the pipeline — stages consume it, callers never construct it.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tokenCounter` | [`TokenCounter`](#tokencounter) | — | Token counter for measuring compression. |
| `budget` | [`Budget`](#budget) | — | Budget available to the segments the stage sees (locked segments' tokens already subtracted). |
| `model` | `string` | `undefined` | Target model (for model-aware compression). |
| `query` | `string` | `undefined` | The task/question this context will serve (query-aware compression). |
| `debug` | `boolean` | `undefined` | Whether debug mode is enabled. |
| `logger` | [`PipelineLogger`](#logger) | `undefined` | The pipeline's logger; stages emit diagnostics through it. |

### IncrementalResult

Returned by the incremental pipeline's `compress`.

| Field | Type | Description |
|-------|------|-------------|
| `result` | `PipelineResult` | Compressed segments + metrics (same shape as the batch [`compress`](#compress) output). |
| `state` | `PipelineState` | Opaque cache state — pass to the next turn's `compress` call. |
| `cachedSegmentCount` | `number` | Segments reused from cache this turn. |
| `freshSegmentCount` | `number` | Segments freshly compressed this turn. |

### TokenCounter

| Field | Type | Description |
|-------|------|-------------|
| `countTokens` | `(text: string, model?: string) => number` | Count tokens in a string, optionally model-aware. |

### TokenScorer

| Field | Type | Description |
|-------|------|-------------|
| `score` | `(content: string, context?: ScorerContext) => ScoredToken[]` | Score every token in the content for importance. |

### ScoredToken

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | `string` | — | The token text (word, whitespace, or punctuation). |
| `score` | `number` | — | Importance score (0.0 = expendable, 1.0 = critical). |
| `offset` | `number` | — | Original position index for order-preserving reconstruction. |
| `protected` | `boolean` | `false` | Never dropped, even under budget pressure (e.g. negations — removing "not" inverts meaning). |

### ScorerContext

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | `string` | `undefined` | Role of the segment being scored (for role-aware rules). |
| `allContent` | `string[]` | `undefined` | Content of all segments (for cross-segment frequency analysis). |
| `query` | `string` | `undefined` | Query string for query-contrastive scoring. |

### RelevanceOptions

Pseudo-relevance-feedback tuning for relevance allocation. Defaults are the measured-best configuration (tuned on a MuSiQue slice disjoint from every reported benchmark subset).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prfRounds` | `number` | `2` | Feedback rounds. Round *r* expands from the highest-ranked segment not yet used as a source, at weight `expansionWeight^r` — round 2 lets a hop-2 segment pull in a hop-3 segment. |
| `expansionTerms` | `number` | `12` | Max expansion terms taken per round. |
| `expansionWeight` | `number` | `0.7` | Per-round weight decay for expansion terms. |

### ModelProfile

Capability profile consulted by the format selector, cache policy, and budget sanity checks. Matched by model-string prefix; custom profiles merge over built-ins.

| Field | Type | Description |
|-------|------|-------------|
| `family` | `string` | Model family name (matched via prefix). |
| `supportsTabular` | `boolean` | Can the model comprehend tabular input formats? |
| `prefersJson` | `boolean` | Does the model work better with JSON for structured data? |
| `maxContextTokens` | `number` | Context window size (pipeline warns when the budget exceeds it). |
| `supportsCaching` | `boolean` | Does the provider support prompt caching? (consulted by `applyCachePolicy`) |

### EmbeddingProvider

| Field | Type | Description |
|-------|------|-------------|
| `embed` | `(texts: string[]) => Promise<number[][]>` | Embed a batch of texts. |
| `dimensions` | `number` | Embedding dimensionality. |

### CompressionProvider

| Field | Type | Description |
|-------|------|-------------|
| `scoreTokenImportance` | `(tokens: string[], context?: string) => Promise<number[]>` | Score token importance (used by self-information pruning pre-computation). |

### SummarizationProvider

| Field | Type | Description |
|-------|------|-------------|
| `summarize` | `(text: string, maxTokens: number) => Promise<string>` | Summarize text to a token budget. |

## Next steps

- [Workflow State](/docs/concepts/workflow-state/) — how memory flows through the orchestrator
- [Memory System](/docs/concepts/memory/) — hierarchical knowledge graph that feeds the context engine
- [Budget-Aware Model Selection](/docs/guides/model-selection/) — how model choice affects compression
- [Context Engine Guide](/docs/guides/context-engine/) — worked examples: standalone, orchestrator, multi-turn loops, memory stack
