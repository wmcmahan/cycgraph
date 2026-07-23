<div align="center">

# @cycgraph/context-engine

**A composable prompt-compression pipeline for TypeScript LLM stacks. Make every token count.**

[![npm](https://img.shields.io/npm/v/@cycgraph/context-engine?color=cb3837)](https://www.npmjs.com/package/@cycgraph/context-engine)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Standalone](https://img.shields.io/badge/standalone-zero%20deps%20except%20zod-3b82f6)](#zero-dependency-core)


</div>

---

A composable compression pipeline for LLM prompts. Strip repeated facts, verbose serialisation, and stale reasoning traces from long memory payloads before they leave your code path — without losing what the model actually needs. Works standalone with any LLM framework (Vercel AI SDK, LangChain.js, the OpenAI SDK directly) or drops into [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator).

- **[Concept guide](https://flattop.io/docs/concepts/context-engine/)**
- **[Pipeline](https://flattop.io/docs/concepts/context-engine/#pipeline)**
- **[Stages](https://flattop.io/docs/concepts/context-engine/#stages)**
- **[API](https://flattop.io/docs/concepts/context-engine/#api)**
- **[Interfaces](https://flattop.io/docs/concepts/context-engine/#interfaces)**
- **[Benchmarks](./BENCHMARKS.md)**


## Install

```bash
npm install @cycgraph/context-engine
```

## How it works

The engine is a pipeline of composable compression stages, ordered by one invariant: cheap lossless transforms first (format re-serialization), redundancy removal second (dedup), lossy content selection third (pruning, distillation), and the budget allocator always last as the enforcement backstop. Everything before the allocator reduces tokens opportunistically; the allocator guarantees the output fits the budget.

Three presets package measured configurations — or compose stages yourself with `createPipeline`:

| Preset | Stages | Measured latency* |
|---|---|---|
| **fast** | format → exact dedup → allocator | ~10–14 ms |
| **balanced** | + CoT distillation, fuzzy dedup, heuristic pruning | ~16–28 ms |
| **maximum** | + hierarchy/graph formatters, model-aware format selection | ~16–29 ms |

\* Mean per-compression latency on the benchmark's 1–5k-token multi-document payloads; small payloads run in low single-digit milliseconds. See [BENCHMARKS.md](./BENCHMARKS.md) for accuracy at matched compression ratios.

## Core Concepts

- **Composable stages** — mix and match: format compression, exact, fuzzy, and semantic dedup, CoT distillation, heuristic pruning, self-information pruning, and budget allocation. Use the bundled **fast**, **balanced**, or **maximum** presets or build your own pipeline.
- **Query-aware relevance allocation** — pass a `query` (the question or goal the context serves) and the presets' budget allocator concentrates budget on query-relevant segments via BM25 + pseudo-relevance feedback. At a 0.3 compression target it retained 67/82 answerable questions vs 51/82 for LLMLingua-2 on HotpotQA, and 23/47 vs 13/47 on multi-hop MuSiQue (both n=100, matched budgets, paired F1 deltas significant), at ~4ms vs ~600-950ms per compression. Without a query, allocation is proportional — identical to previous behavior. Full tables, negative results, and reproduction commands: [BENCHMARKS.md](./BENCHMARKS.md). Design rationale, algorithms, and methodology: [technical whitepaper](./docs/whitepaper.md).
- **No LLM call required at the base tier** — default tier is pure TypeScript. Higher tiers add a token counter, an embedding provider, or a small local model for additional accuracy.
- **Model-aware format routing** — checks the target model's capability profile and picks a representation that fits. Custom profiles can be merged in.
- **Cache-aware prefix locking** — stabilises the static prompt prefix so provider-side prompt caches get consistent cache hits across turns. Pass a `model` and locking is skipped for providers without a prompt cache.
- **Streaming-friendly** — an incremental pipeline supports turn-by-turn compression for long sessions without re-running the whole pipeline each turn.
- **Bring your own LLM stack** — the package doesn't import any LLM SDK. Plug into Vercel AI SDK, LangChain.js, the OpenAI / Anthropic SDKs directly, or raw fetch.

## Use Cases

- **Reduce LLM API costs** - Strip repeated facts, verbose serialisation, and stale reasoning traces from long memory payloads before they leave your code path
- **Keep memory payloads within context budgets** - Use the bundled **fast**, **balanced**, or **maximum** presets or build your own pipeline to compress memory payloads to fit within token budgets
- **Improve LLM performance** - Smaller prompts can lead to faster response times and improved model performance
- **Reduce input token costs for prompts that contain:**

The compression engine catches each of these with a dedicated stage, runs them in order, and stays within a token budget you set.

## Example

The simplest entry point — pick a preset, compress segments to fit a budget:

```typescript
import { createOptimizedPipeline } from '@cycgraph/context-engine';

const pipeline = createOptimizedPipeline({
  preset: 'balanced'
});

const result = pipeline.compress({
  segments: [
    {
      id: 'system',
      content: 'You are a research assistant.',
      role: 'system',
      priority: 1
    },
    {
      id: 'memory',
      content: JSON.stringify(largeMemoryObject),
      role: 'memory',
      priority: 1
    },
    {
      id: 'user',
      content: 'Summarise the findings.',
      role: 'user',
      priority: 1
    },
  ],
  budget: {
    maxTokens: 8_192,
    outputReserve: 1_024
  },
});
```

For use with [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator), pass the pipeline as a `contextCompressor` to `GraphRunnerOptions`. The orchestrator calls it before injecting memory into agent and supervisor prompts. 

See [`Context Compression`](https://flattop.io/docs/concepts/context-engine/) in the docs for more details.

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import {
  createOptimizedPipeline,
  serialize,
} from '@cycgraph/context-engine';

const pipeline = createOptimizedPipeline({
  preset: 'balanced'
});

const contextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{
      id: 'memory',
      content: serialize(sanitizedMemory),
      role: 'memory',
      priority: 1,
    }],
    budget: {
      maxTokens: options?.maxTokens ?? 8192,
      outputReserve: 0,
    },
    // The runner passes the sanitized workflow goal as `options.query` —
    // forwarding it activates relevance-aware allocation (goal-relevant
    // memory keeps budget preferentially).
    query: options?.query,
  });
  return {
    compressed: result.segments[0].content,
    metrics: result.metrics,
  };
};

const runner = new GraphRunner(graph, state, { contextCompressor });
```

## Custom pipelines

When the presets don't fit, build the pipeline directly:

```typescript
import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createFuzzyDedupStage,
  createAllocatorStage,
} from '@cycgraph/context-engine';

const pipeline = createPipeline({
  stages: [
    createFormatStage(),
    createExactDedupStage(),
    createFuzzyDedupStage({ threshold: 0.85 }),
    createAllocatorStage(),
  ],
});

const result = pipeline.compress({ segments, budget });
```

For custom stages, declare a scope of `per-segment` only if each segment's output depends solely on that segment's own content. Undeclared scope is treated as `cross-segment`, which is always correct, but it opts the stage out of per-segment caching in the incremental pipeline.

Order per-segment stages before cross-segment ones. The incremental pipeline executes them in two phases, per-segment first, then cross-segment; keeping your config in that order makes batch and incremental output identical.

## Capability Tiers

The pipeline runs at the tier you supply. Higher tiers add capabilities without changing the API.


- **Tier 0** - Default (pure TypeScript)
- **Tier 1** - A token counter
- **Tier 2** - An embedding provider
- **Tier 3** - A small local model (GPT-2 / Phi-2)

## Memory-payload formatting

Memory payloads (facts, entities, themes from a knowledge graph) often dominate token cost. Dedicated formatters compress them into compact representations:

| Input shape | Formatter | Output style |
|---|---|---|
| Hierarchical memory (xMemory) | `formatHierarchy` | Themes with grouped facts (validity dates), episode summaries |
| Knowledge graph (entities + edges) | `serializeGraph` | Per-type tables (uniform attributes) or lossless adjacency list |
| Community summaries (GraphRAG) | `formatCommunities` | Weight-sorted community rollups with truncated summaries |

A `selectFormat()` helper picks the representation from the target model's capability profile (`supportsTabular`, `prefersJson`): capable models get compact tabular/nested formats, small models that parse JSON more reliably get compact JSON. Built-in profiles cover common model families; pass `customProfiles` to add or override them.

## Observability

Every compression call returns metrics: per-stage `tokensIn`, `tokensOut`, `durationMs`, total reduction percent, format selection decisions, cache stability diagnostics. Wire to Prometheus or your tracing of choice.

Debug mode results also carry a **source map**: per-segment provenance (`original` -> `compressed`, which stages changed each segment in order, and which stage removed or introduced one). The incremental pipeline threads provenance across cached turns.

A `LatencyTracker` + `CircuitBreaker` pair lets you skip slow stages under load — graceful degradation when a downstream embedding service is flaky.

Cache stability comes in two measures:

- `measureCacheHitRate` - set-based upper bound. Identical items are considered equal.
- `measurePrefixStability` - prefix-faithful — a change or reorder at position k invalidates everything after it, matching how provider prompt caches actually behave.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).