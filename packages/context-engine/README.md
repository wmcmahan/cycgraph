<div align="center">

# @cycgraph/context-engine

**A composable prompt-compression pipeline for TypeScript LLM stacks. Make every token count.**

[![npm](https://img.shields.io/npm/v/@cycgraph/context-engine?color=cb3837)](https://www.npmjs.com/package/@cycgraph/context-engine)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Standalone](https://img.shields.io/badge/standalone-zero%20deps%20except%20zod-3b82f6)](#zero-dependency-core)

[📚 Documentation](https://flattop.io/concepts/context-engine/) &nbsp;·&nbsp; [📖 Strategy](./STRATEGY.md)

</div>

---

`@cycgraph/context-engine` is a **composable compression pipeline** for LLM prompts. Strip repeated facts, verbose serialisation, and stale reasoning traces from long memory payloads before they leave your code path — without losing what the model actually needs. Works standalone with any LLM framework (Vercel AI SDK, LangChain.js, the OpenAI SDK directly) or drops into [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator) via the `contextCompressor` hook.

## Why this exists

You're paying input-token rates on prompts that contain:
- The same fact repeated three times because the LLM phrased it slightly differently each round
- Verbose JSON when a one-line tabular row would parse identically
- Reasoning traces from earlier turns the LLM no longer needs to see
- Filler stems and rephrased re-stems that contribute nothing

The compression engine catches each of these with a dedicated stage, runs them in order, and stays within a token budget you set.

## How it works

- **Composable stages** — mix and match: format compression, exact / fuzzy / semantic dedup, CoT distillation, heuristic pruning, self-information pruning, budget allocation. Use the bundled `balanced` / `aggressive` / `conservative` presets or build your own pipeline.
- **No LLM call required at the base tier** — tier 0 is pure TypeScript with `zod`. Higher tiers add a token counter, an embedding provider, or a small local model for additional accuracy.
- **Model-aware format routing** — `selectFormat()` checks the target model's capability profile (`supportsTabular`, `supportsNested`, `prefersJson`) and picks a representation that fits. Custom profiles can be merged in.
- **Cache-aware prefix locking** — stabilises the static prompt prefix so provider-side prompt caches (e.g. Anthropic prompt caching) get consistent cache hits across turns.
- **Streaming-friendly** — an incremental pipeline (`createIncrementalPipeline`) supports turn-by-turn compression for long sessions without re-running the whole pipeline each turn.
- **Bring your own LLM stack** — the package doesn't import any LLM SDK. Plug into Vercel AI SDK, LangChain.js, the OpenAI / Anthropic SDKs directly, or raw `fetch`.

## Capability tiers

The pipeline runs at the tier you supply. Higher tiers add capabilities without changing the API.

| Tier | What you provide | Reduction range |
|---|---|---|
| **0** | Nothing — pure TypeScript with `zod` | 15–45% |
| **1** | A token counter (`tiktoken` or a custom adapter) | +5–10% (exact budgeting) |
| **2** | An embedding provider | +10–20% (semantic dedup) |
| **3** | A small local model (GPT-2 / Phi-2) | +30–50% (perplexity-based pruning) |

A `tiktoken` adapter ships with the package. Embedding and local-model adapters are user-provided through three small interfaces.

## Install

```bash
npm install @cycgraph/context-engine
```

Zero runtime dependencies except `zod`.

## Quick taste

The simplest entry point — pick a preset, compress segments to fit a budget:

```typescript
import { createOptimizedPipeline } from '@cycgraph/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const result = pipeline.compress({
  segments: [
    { id: 'system', content: 'You are a research assistant.', role: 'system', priority: 1 },
    { id: 'memory', content: JSON.stringify(largeMemoryObject), role: 'memory', priority: 1 },
    { id: 'user', content: 'Summarise the findings.', role: 'user', priority: 1 },
  ],
  budget: { maxTokens: 8_192, outputReserve: 1_024 },
});

console.log(result.metrics);
// {
//   totalTokensIn: 12450,
//   totalTokensOut: 4870,
//   reductionPercent: 60.9,
//   stages: [ { name: 'format', tokensIn: 12450, tokensOut: 8200, durationMs: 2 }, ... ],
// }

// Send `result.segments` to your LLM however you normally would.
```

Presets: `aggressive`, `balanced`, `conservative`. Or build your own pipeline stage by stage.

## Pipeline architecture

```
Input segments (system, memory, tools, history, user)
  ↓  Cache-Aware Prefix Locking      ← stabilises prompt prefix for provider caching
  ↓  Hierarchy / Graph Formatting    ← memory payloads → compact representation
  ↓  Model-Aware Format Selection    ← per-target-model optimization (Claude vs GPT vs Haiku)
  ↓  Format Compression              ← JSON → tabular / flat object / nested compact
  ↓  Exact Deduplication             ← hash-based
  ↓  Fuzzy Deduplication             ← trigram similarity
  ↓  Semantic Deduplication          ← embedding-based (tier 2+)
  ↓  CoT Distillation                ← reasoning-trace eviction
  ↓  Self-Information Pruning         ← perplexity-based (tier 3+)
  ↓  Heuristic Pruning               ← rule-based
  ↓  Budget Allocation               ← priority-weighted, within token cap
Output segments (compressed, within budget)
```

Each stage is **independent and composable**. Use the full pipeline, a single stage, or your own ordering.

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
    createFormatStage({ strategy: 'auto' }),      // pick best format per shape
    createExactDedupStage(),                       // hash-based exact match
    createFuzzyDedupStage({ similarity: 0.85 }),   // trigram near-match
    createAllocatorStage({ strategy: 'priority' }),// fit within budget
  ],
});

const result = pipeline.compress({ segments, budget });
```

## Use cases

- **You're paying for redundant content in your input tokens.** Drop the engine in front of your existing prompt build step. The actual reduction depends on data shape and which tiers you wire up — see the [Capability tiers](#capability-tiers) table.
- **You want to extend usable context-window real estate.** Same model, same budget — fit more relevant content.
- **You're building an agent framework or RAG system.** The format-compression stage alone often pays for itself on serialised knowledge graphs.
- **You want provider-side prompt caching to hit consistently.** The cache-aware prefix locking stage stabilises the static prefix so caches stop churning on small turn-over-turn differences.

## Memory-payload formatting

Memory payloads (facts, entities, themes from a knowledge graph) often dominate token cost. Dedicated formatters compress them into compact representations:

| Input shape | Formatter | Output style |
|---|---|---|
| Hierarchical memory (xMemory) | `formatHierarchy` | `Theme: X / Facts: ... / Entities: ...` indented block |
| Knowledge graph (entities + edges) | `serializeGraph` | Markdown adjacency table |
| Community summaries (GraphRAG) | `formatCommunities` | Theme rollups with delta-encoded membership |

A `selectFormat()` helper picks among these based on the target model's capability profile (`supportsTabular`, `supportsNested`, `prefersJson`). Built-in profiles cover common model families; custom profiles can be merged in.

## Standalone or as cycgraph's compression layer

**Standalone** — Build prompts in your own framework, pass segments through the pipeline, render the output however you like. The pipeline doesn't know or care about your LLM client.

**With `@cycgraph/orchestrator`** — Pass the pipeline as a `contextCompressor` to `GraphRunnerOptions`. The orchestrator calls it before injecting memory into agent and supervisor prompts. See [Context Compression](https://flattop.io/concepts/context-engine/) in the docs.

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, serialize } from '@cycgraph/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{ id: 'memory', content: serialize(sanitizedMemory), role: 'memory', priority: 1 }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { contextCompressor });
```

## Observability

Every compression call returns metrics: per-stage `tokensIn` / `tokensOut` / `durationMs`, total reduction percent, format selection decisions, cache stability diagnostics. Wire to Prometheus or your tracing of choice.

A `LatencyTracker` + `CircuitBreaker` pair lets you skip slow stages under load — graceful degradation when a downstream embedding service is flaky.

## Documentation

- **[Context engine concept guide](https://flattop.io/concepts/context-engine/)** — the full architecture
- **[Strategy doc](./STRATEGY.md)** — research foundation for each stage (LongLLMLingua, GraphRAG, CoT distillation, etc.)

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).