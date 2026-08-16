---
title: Context Engine Guide
description: Context Engine Guide for integrating with LLM calls, the orchestrator, multi-turn loops, and the memory stack.
---

The context engine works as an optional layer between your data and the LLM. It compresses memory payloads, deduplicates content, and prunes low-value tokens. You can use it with any LLM framework, but it is especially useful with the orchestration graph.

## Standalone

The engine is framework-agnostic. It transforms prompt segments into compressed prompt segments. You can use it with any LLM framework by simply passing the segments directly to the engine and then joining the resulting segments.

```typescript
import { createOptimizedPipeline, serialize } from '@cycgraph/context-engine';

const pipeline = createOptimizedPipeline({ preset: 'fast' });

const { segments, metrics } = pipeline.compress({
  query: userPrompt,
  segments: [
    {
      id: 'instructions',
      content: systemPrompt,
      role: 'system',
      priority: 10,
      locked: true,
    },
    {
      id: 'memory',
      content: serialize(retrievedFacts),
      role: 'memory',
      priority: 5,
    },
    {
      id: 'history',
      content: chatHistory,
      role: 'history',
      priority: 3,
    },
  ],
  budget: {
    maxTokens: 8_192,
    outputReserve: 1_024,
  },
});
```

**What this means:**

- `locked`: With the system prompt is `locked`, meaning it is never mutated, but its tokens are charged against the budget first.

- `outputReserve`: This keeps room for the completion budget, ensuring that the budget allocator always leaves room for the LLM to complete its response.

- `query`: Passing the user's question as `query` switches the preset's allocator into relevance mode, concentrating the budget on question-relevant segments instead of splitting it proportionally. Omit `query` and you get query-agnostic compression; both fit the budget.

## Orchestrator

For cycgraph orchestration graphs, wire the pipeline in as a `contextCompressor`. The runner calls it before injecting workflow memory into the prompts of nodes in the graph

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

const runner = new GraphRunner(workflow, initialState, { contextCompressor });
```

**What this means:**

- Every variable-size prompt section arrives as its own segment — `system`, `goal`, `retrieved`, `task_context`, `memory`, `instructions`, plus `routing_history` for supervisors — so one budget is allocated across the whole prompt rather than over memory alone. Results are matched back by `id`, and a segment you do not return keeps its original content.

- Segments marked `locked` (system, goal, instructions) must come back byte-identical. The runner discards the entire result and falls back if one is modified, because rewriting them would change what the agent was told to do.

- The orchestrator sanitizes memory before the compressor sees it and re-sanitizes everything it returns. Boundary markers such as `<data>` tags are emitted around segments, never inside them, so no stage can strip a guard.

- The runner does not track model context windows, so `maxTokens` is usually absent and the implementation resolves its own ceiling from `options.model`. What the agent may generate comes out of that window, which is what `outputReserve` reserves.

- Forwarding `options.query` (the sanitized workflow goal) activates relevance-aware allocation. Omitting it is byte-identical to query-agnostic compression.

- The integration fails open: if your compressor throws or returns `null`, the runner falls back to plain `JSON.stringify` with a 50KB byte cap. Compression is an optimization, never a correctness dependency.

## Multi-turn agent loop

This example is for applications that drive their own conversation loop **without** the orchestrator: a chatbot backend, a REPL assistant, a custom agent. "Session" and "turn" here are your application's concepts, not the engine's or the orchestrator's. Inside an orchestration graph, the runner drives execution and calls your `contextCompressor` on every prompt build, so there is no loop to write.

Long-running sessions re-compress mostly unchanged context every turn, and they interact with a second cache you don't own: the provider's prompt cache. This example wires the engine's three caching layers together:

```typescript
import {
  createIncrementalPipeline,
  createFormatStage,
  createExactDedupStage,
  createAllocatorStage,
  applyCachePolicy,
  computeSegmentHashMap,
  diagnoseCacheStability,
  serialize,
} from '@cycgraph/context-engine';
import type { PromptSegment } from '@cycgraph/context-engine';

const pipeline = createIncrementalPipeline({
  stages: [
    createFormatStage(),
    createExactDedupStage(),
    createAllocatorStage(),
  ],
});

const budget = { maxTokens: 8_192, outputReserve: 1_024 };

type Turn = { goal: string; model: string; history: string; facts: unknown };
const turns: Turn[] = [];

function buildSegments(turn: Turn): PromptSegment[] {
  return [
    {
      id: 'system',
      content: 'You are a research assistant.',
      role: 'system',
      priority: 10
    },
    {
      id: 'memory',
      content: serialize(turn.facts),
      role: 'memory',
      priority: 5
    },
    { 
      id: 'history',
      content: turn.history,
      role: 'history',
      priority: 3
    },
  ];
}

let state = undefined;
let previousHashes = undefined;

for (const turn of turns) {
  const segments = applyCachePolicy(buildSegments(turn), { model: turn.model });

  const { result, state: nextState, cachedSegmentCount } = pipeline.compress(
    { segments, budget, query: turn.goal },
    state,
  );
  state = nextState;
  console.log(`turn ${nextState.turnNumber}: ${cachedSegmentCount} segments from cache`);

  if (previousHashes) {
    const diag = diagnoseCacheStability(segments, previousHashes);
    if (diag.hitRate < 0.8) console.warn(diag.recommendations);
  }
  previousHashes = computeSegmentHashMap(segments);
}
```

**What this means:**

- The incremental pipeline saves compute by not re-compressing unchanged segments.

- The cache policy protects the provider's discount by refusing to re-optimize the prompt prefix. A compressor that rewrites the prefix every turn saves tokens while forfeiting cached-token pricing, which can cost more than it saves.

- Locking before compression is what keeps the two aligned, and `diagnoseCacheStability` tells you when dynamic content (timestamps, UUIDs) is silently invalidating the prefix anyway.

- Note the `query` is part of the incremental cache's fingerprint: a new goal invalidates the cache, because relevance allocation depends on it.

## The memory stack

When prompts carry retrieved knowledge from `@cycgraph/memory`, add the adaptive memory stage so hierarchy signals (theme size, fact recency) decide what survives, rather than serialization order:

```typescript
import { InMemoryMemoryStore, InMemoryMemoryIndex, retrieveMemory } from '@cycgraph/memory';
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

const memoryResult = await retrieveMemory(store, index, { limit: 50 });

const result = pipeline.compress({
  segments: [
    { id: 'memory', content: serialize(memoryResult), role: 'memory', priority: 5 },
  ],
  budget: { maxTokens: 4_096, outputReserve: 1_024 },
});
```

**What this means:**

- Retrieval decides *what's relevant enough to fetch*; the adaptive stage decides *what's important enough to keep* when the fetched payload exceeds the budget, so recent facts and facts from well-populated themes win.

- The format stage then squeezes the surviving JSON shape, and the allocator guarantees the fit.

- Because the payload is structured (role `memory`), no stage will token-prune inside it. Over-budget structured content tail-truncates cleanly instead of being corrupted.

For the retrieval side of this stack, see [Memory System](/docs/guides/memory/).

## Opt-in provider paths

The presets never call a model. The provider-backed stages are opt-in, and because `compress()` is synchronous, they use a two-phase pattern: pre-compute asynchronously, then compress. Semantic dedup with an embedding provider:

```typescript
import {
  createPipeline,
  createSemanticDedupStage,
  precomputeEmbeddings,
  createAllocatorStage,
} from '@cycgraph/context-engine';

const provider = myEmbeddingProvider;

const precomputed = await precomputeEmbeddings(segments, provider);

const pipeline = createPipeline({
  stages: [
    createSemanticDedupStage({ provider, precomputed, threshold: 0.9 }),
    createAllocatorStage(),
  ],
});
const result = pipeline.compress({ segments, budget });
```

The same pattern applies to neural importance scoring: `precomputeImportanceScores(segments, compressionProvider)` feeds `createSelfInformationStage({ precomputed })`. If you skip pre-computation, semantic dedup finds nothing to compare and self-information falls back to the n-gram scorer. Both degrade gracefully rather than blocking.

**What this means:** the hot path stays deterministic and fast even when providers are wired in, because all network latency is paid once, up front, where you control it. Consider wrapping provider-backed stages in a [circuit breaker](/docs/concepts/context-engine/#circuit-breaker) so they bypass themselves on workloads where they stop earning their latency.

## Choosing a preset, and when to go custom

The presets are content-profile decisions, not a quality ladder:

- **`fast`**: the default choice for extractive workloads such as dense factual documents, tool outputs, and retrieved passages where every sentence may matter. Its stages are lossless-or-safe (format, exact dedup, allocator), so information loss happens only under budget pressure, and the [benchmarks](/docs/concepts/context-engine/#relevance-allocation-query-aware) show it beating the heavier presets on downstream QA at matched budgets.
- **`balanced` / `maximum`**: for verbose, redundant, reasoning-heavy payloads such as long chat histories, agent scratch work, and repeated boilerplate. The pruning and distillation stages earn their keep exactly where there's filler to remove; on dense factual content those same deletions land on substance.
- **Always pass `query` when the task is known.** It's free when absent, and at tight budgets relevance allocation is the largest quality lever the engine has.
- **Go custom** when you need provider-backed stages (never in presets), memory/graph formatters outside `maximum`, or a different allocator configuration. Compose with `createPipeline` and keep per-segment stages first, allocator last. See the [stage catalog](/docs/concepts/context-engine/#stages).

## Next steps

- [Context Engine](/docs/concepts/context-engine/): architecture, stage catalog, and full API reference
- [Memory System](/docs/concepts/memory/): the knowledge graph that feeds the context engine
- [Budget-Aware Model Selection](/docs/guides/model-selection/): how model choice affects compression
