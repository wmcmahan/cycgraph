---
title: Using the Context Engine
description: Practical guide for integrating context compression into your workflows.
---

This guide covers the practical steps for adding context compression to a workflow. For background on pipeline architecture, scoring algorithms, and budget management, see [Context Engine](/docs/concepts/context-engine/).

## Quick start

The fastest way to compress context in a workflow:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, serialize } from '@cycgraph/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{
      id: 'memory',
      content: serialize(sanitizedMemory),
      role: 'memory',
      priority: 1,
    }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
    model: options?.model,
    // The runner passes the sanitized workflow goal as `options.query`.
    // Forward it: the presets' relevance allocation concentrates budget
    // on goal-relevant memory. Without a query, behavior is unchanged.
    query: options?.query,
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { contextCompressor });

runner.on('context:compressed', (event) => {
  console.log(`Memory: ${event.reduction_percent.toFixed(1)}% reduction`);
});
```

## Choosing a preset

| Scenario | Preset | Why |
|----------|--------|-----|
| Low-latency chat | `fast` | Minimal overhead, format + dedup only |
| General workflows | `balanced` | Good compression with heuristic pruning |
| Cost-sensitive / small models | `maximum` | Full pipeline with hierarchy formatting |

## Multi-turn compression

For workflows with multiple turns, use the incremental pipeline to avoid re-compressing unchanged context:

```typescript
import { createIncrementalPipeline, createFormatStage, createExactDedupStage } from '@cycgraph/context-engine';

const pipeline = createIncrementalPipeline({
  stages: [createFormatStage(), createExactDedupStage()],
});

let state = undefined;

for (const turn of turns) {
  const { result, state: nextState, cachedSegmentCount } = pipeline.compress(
    { segments: buildSegments(turn), budget },
    state,
  );
  state = nextState;
  console.log(`Turn ${nextState.turnNumber}: ${cachedSegmentCount} segments cached`);
}
```

The incremental pipeline tracks per-segment output hashes, so cross-segment stages (like fuzzy dedup) only re-run when per-segment outputs actually change — not just when inputs change. This avoids expensive re-runs when a segment's content changes but its compressed output stays the same.

Two things to know when bringing custom stages:

- A stage without a `scope` declaration is treated as **cross-segment** (safe, but uncached). Declare `scope: 'per-segment'` to opt into per-segment caching — only valid when each segment's output depends solely on its own content.
- Order per-segment stages before cross-segment ones. The incremental pipeline runs them as two phases in that order, and an interleaved config diverges from the batch pipeline (a construction-time warning flags this).

## Pipeline safety

### Timeout

Set a pipeline-level timeout to bound total compression time. Remaining stages are skipped if exceeded:

```typescript
const pipeline = createPipeline({
  stages: [...],
  timeoutMs: 200,  // hard cap at 200ms
});
```

### Logger

Route diagnostic output through a structured logger:

```typescript
const pipeline = createPipeline({
  stages: [...],
  logger: {
    warn: (msg) => myLogger.warn(msg),
    debug: (msg) => myLogger.debug(msg),
  },
});
```

## Query-aware compression

### Relevance allocation (preset default)

When the `compress()` input carries a `query`, the presets' budget allocator switches to relevance mode: segments are ranked by BM25 relevance to the query (with stemming and pseudo-relevance feedback for multi-hop bridging) and budget is granted whole-segment greedily — relevant segments stay intact, irrelevant ones are starved. Without a query, behavior is identical to proportional allocation.

```typescript
const result = pipeline.compress({
  segments,
  budget: { maxTokens: 4096, outputReserve: 0 },
  query: workflowGoal,
});
```

Inside a `GraphRunner` workflow you don't need to do anything: the runner passes the sanitized workflow goal as `options.query` to your `contextCompressor` — just forward it as shown in the quick start. See [Relevance allocation](/docs/concepts/context-engine/#relevance-allocation-query-aware) for benchmark results.

### Token-level query weighting

Separately, you can configure the heuristic scorer to weight tokens that match the query, so query-relevant content survives pruning at the expense of unrelated text:

```typescript
import { createPipeline, createHeuristicPruningStage, createAllocatorStage } from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [
    createHeuristicPruningStage({ queryWeight: 0.25 }),
    createAllocatorStage(),
  ],
});

const result = pipeline.compress({
  segments: [
    { id: 'query', content: userQuery, role: 'custom', priority: 10, locked: true },
    { id: 'memory', content: serialize(memory), role: 'memory', priority: 5 },
  ],
  budget: { maxTokens: 4096, outputReserve: 512 },
});
```

Mark the query segment as `locked: true` so it is never pruned — the heuristic scorer reads its tokens to compute relevance scores for the unlocked segments. `queryWeight` is a multiplier between `0` and `1`; higher values bias the scorer more heavily toward query-matching content.

## Working with memory payloads

When compressing memory from `@cycgraph/memory`, use the adaptive memory stage to prioritize recent and high-relevance facts:

```typescript
import {
  createPipeline,
  createAdaptiveMemoryStage,
  createFormatStage,
  createAllocatorStage,
  serialize,
} from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [
    createAdaptiveMemoryStage({ recencyBoostDays: 7, maxFactsPerTheme: 10 }),
    createFormatStage(),
    createAllocatorStage(),
  ],
});

// Serialize memory retrieval result to JSON
const memoryJson = serialize(memoryResult);

const result = pipeline.compress({
  segments: [
    { id: 'system', content: systemPrompt, role: 'system', priority: 10, locked: true },
    { id: 'memory', content: memoryJson, role: 'memory', priority: 5 },
    { id: 'history', content: chatHistory, role: 'history', priority: 3 },
  ],
  budget: { maxTokens: 4096, outputReserve: 1024 },
});
```

## Monitoring compression

### Pipeline metrics

Every compression call returns detailed metrics:

```typescript
const { metrics } = result;
console.log(`Total: ${metrics.totalTokensIn} -> ${metrics.totalTokensOut} tokens`);
console.log(`Reduction: ${metrics.reductionPercent.toFixed(1)}%`);
console.log(`Duration: ${metrics.totalDurationMs.toFixed(0)}ms`);

for (const stage of metrics.stages) {
  console.log(`  ${stage.name}: ${stage.ratio.toFixed(2)}x (${stage.durationMs.toFixed(0)}ms)`);
}
```

### Cache-aware locking

Lock the static prompt prefix (system prompt, tool schemas) before compressing so provider prompt caches see byte-identical prefixes across turns. Pass the target `model` — for providers without a prompt cache, no locks are added and the content stays compressible:

```typescript
import { applyCachePolicy } from '@cycgraph/context-engine';

const locked = applyCachePolicy(segments, { model: 'claude-sonnet-4-6' });
const result = pipeline.compress({ segments: locked, budget });
```

### Cache diagnostics

Detect when API prompt caching is being invalidated by dynamic content:

```typescript
import { diagnoseCacheStability, computeSegmentHashMap } from '@cycgraph/context-engine';

// Track hashes between turns
const hashes = computeSegmentHashMap(segments);
const diagnostics = diagnoseCacheStability(segments, previousHashes);

if (diagnostics.hitRate < 0.8) {
  console.warn('Low cache hit rate:', diagnostics.recommendations);
}
```

For a prefix-faithful measure (position-sensitive, like real provider caches), use `measurePrefixStability` with `computePrefixHashList` — a change early in the prompt counts everything after it as invalidated.

### Debug source maps

When a compressed prompt looks wrong, run with `debug: true` and inspect the source map — each mutable segment gets an entry with its `original` and `compressed` content, the ordered list of stages that `changedBy` it, and flags for stage removals/additions. The incremental pipeline carries provenance across cached turns (`fromCache: true`). See [Debug source maps](/docs/concepts/context-engine/#debug-source-maps) for the full shape.

### Circuit breaker

Wrap expensive stages to auto-bypass when they aren't paying for themselves:

```typescript
import { createCircuitBreaker, createLatencyTracker } from '@cycgraph/context-engine';

const tracker = createLatencyTracker();
const guarded = createCircuitBreaker(semanticDedupStage, tracker, {
  minEfficiency: 1.0,  // must save 1 token per ms of latency
  warmupSamples: 5,
  cooldownMs: 30_000,
});
```

## Next steps

- [Context Engine](/docs/concepts/context-engine/) — architectural deep dive
- [Memory System](/docs/concepts/memory/) — the knowledge graph that feeds the context engine
- [Budget-Aware Model Selection](/docs/guides/model-selection/) — how model choice affects compression
