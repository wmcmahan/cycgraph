---
title: Configuration Reference
description: Every operational tuning knob exposed by cycgraph — env vars, defaults, bounds, and when to change them.
---

cycgraph exposes operational tuning through environment variables (read once at module load, Zod-validated) and constructor options (passed when wiring components). This page is the single reference for both.

> **Where to override.** Env vars are easiest for ops; constructor options are easiest for tests and embedded deployments. They never conflict — env vars set the defaults, constructor options override per-instance.

## Runtime config (env vars)

All values are validated against `RuntimeConfigSchema` in `@cycgraph/orchestrator/runtime-config`. **Out-of-bounds values throw at module load** rather than producing a broken cache size or negative timeout.

| Env var | Default | Bounds | Purpose |
| --- | --- | --- | --- |
| `AGENT_CONFIG_CACHE_TTL_MS` | `300000` (5 min) | 1s – 1h | TTL for cached agent configs in the factory |
| `MAX_AGENT_CONFIG_CACHE_SIZE` | `100` | 1 – 10,000 | Max cached agent configs |
| `FALLBACK_CONFIG_CACHE_TTL_MS` | `30000` (30s) | 1s – 1h | Shorter TTL for fallback configs so DB recovery is detected sooner |
| `AGENT_TIMEOUT_MS` | `120000` (2 min) | 1s – 1h | Timeout for a single agent LLM invocation |
| `MAX_MEMORY_PROMPT_BYTES` | `51200` (50 KB) | 1 KB – 10 MB | Max serialized memory injected into the system prompt |
| `MAX_MEMORY_VALUE_BYTES` | `1048576` (1 MB) | 1 KB – 100 MB | Max bytes for a single memory value — reducer drops oversized values into `state.memory_drops` |
| `MAX_VISITED_NODES` | `1000` | 10 – 1,000,000 | Ring-buffer cap on `state.visited_nodes` |
| `MAX_SUPERVISOR_HISTORY` | `100` | 10 – 100,000 | Ring-buffer cap on `state.supervisor_history` |
| `MAX_MEMORY_DROPS` | `50` | 1 – 10,000 | Ring-buffer cap on `state.memory_drops` |
| `FILTREX_CACHE_SIZE` | `256` | 8 – 100,000 | LRU cap on the filtrex expression compile cache |

### When to tune

| Symptom | Likely lever |
| --- | --- |
| Workflow logs say `memory_dropped` every run | Raise `MAX_MEMORY_VALUE_BYTES`, or trim the agent's output. Confirm in `state.memory_drops`. |
| LLM 504s under load | Increase `AGENT_TIMEOUT_MS`. Verify it's the LLM that's slow, not your network. |
| OOM on large graphs with deep visited paths | Lower `MAX_VISITED_NODES` (ring buffer). |
| Memory grows over hours of supervisor loops | Lower `MAX_SUPERVISOR_HISTORY`. |
| Cold start latency dominated by graph load | Increase `FILTREX_CACHE_SIZE` if you have many distinct edge conditions. |

## `GraphRunner` options

Passed to `new GraphRunner(graph, state, options)`. Source: `runner/graph-runner.ts`.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `persistence` | `PersistenceProvider` | in-memory | Graph + state storage backend |
| `eventLog` | `EventLogWriter` | in-memory | Append-only event log + checkpoints |
| `usageRecorder` | `UsageRecorder` | noop | Cost / token recorder |
| `toolResolver` | `ToolResolver` | none | MCP tool resolution (`MCPConnectionManager` recommended) |
| `contextCompressor` | `ContextCompressor` | none | Compress memory before prompt injection |
| `memoryRetriever` | `MemoryRetriever` | none | Pull facts from the hierarchical memory graph. Only fires for nodes that declare a `memory_query` directive. |
| `memoryWriter` | `MemoryWriter` | none | Persist facts produced by `reflection` nodes. Required for reflection nodes to function. |
| `factSanitizer` | `FactSanitizer` | none | Pre-write hook applied to every reflection fact. Return `null` to drop, or a modified fact to substitute. Errors are absorbed and the original fact passes through. |
| `middleware` | `RunnerMiddleware[]` | `[]` | `beforeNodeExecute` / `afterReduce` hooks |

## `MCPConnectionManager` options

Source: `mcp/connection-manager.ts`.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `cache_ttl_ms` | `number` | `300000` (5 min) | TTL for cached tool manifests. `0` disables. |
| `default_tool_timeout_ms` | `number` | `30000` (30s) | Per-tool execution timeout. Overridable per-server via `MCPServerEntry.tool_timeout_ms`. |
| `tool_circuit_breaker` | `ToolCircuitBreakerOptions \| null` | enabled with defaults | Per-tool breaker. Pass `null` to disable entirely. |

### `ToolCircuitBreakerOptions`

| Option | Default | Purpose |
| --- | --- | --- |
| `failure_threshold` | `5` | Consecutive failures that open the breaker |
| `success_threshold` | `2` | Consecutive successes in `half_open` to close |
| `cooldown_ms` | `30000` (30s) | Window the breaker stays `open` before transitioning to `half_open` |

Snapshot metrics via `manager.getToolCircuitMetrics()` — wire to a `/metrics` endpoint or middleware.

## `DrizzleEventLogWriter` options

Source: `@cycgraph/orchestrator-postgres`.

| Option | Default | Purpose |
| --- | --- | --- |
| `retain_checkpoints` | `3` | How many checkpoints per run to keep. Older ones are pruned inside the same transaction as each new write. Minimum `1` enforced. |

## `InMemoryMemoryIndex` options

Source: `@cycgraph/memory`.

| Option | Default | Purpose |
| --- | --- | --- |
| `expectedDimensions` | unset | Strict dimension check — every embedding indexed or queried must match. Mismatch throws `EmbeddingDimensionMismatchError`. Wire from `EmbeddingProvider.dimensions`. |
| `silenceScaleWarning` | `false` | Suppress the one-shot console warning when the brute-force index crosses 10K entries. Set `true` only for stress tests. |

## Validation behavior

Misconfiguration **fails loud, not silent**:

- Setting `MAX_MEMORY_VALUE_BYTES=0` would silently drop every memory update. The Zod schema rejects it at startup with a descriptive error.
- Setting `retain_checkpoints=0` would orphan the run from any usable replay anchor. `DrizzleEventLogWriter` throws in its constructor.
- A 512-dim `EmbeddingProvider` talking to a 1536-dim `pgvector` schema produced silently wrong cosine scores. With `expectedDimensions` set, the first query throws.

Every default above is also the recommended starting point — change one knob at a time, watch for the symptom listed in [When to tune](#when-to-tune).
