---
title: Configuration Reference
description: "Every operational tuning knob exposed by cycgraph: env vars, defaults, bounds, and when to change them."
---

cycgraph exposes operational tuning through environment variables (read once at module load, Zod-validated) and constructor options (passed when wiring components). This page is the single reference for both.

> **Where to override.** Env vars are easiest for ops; constructor options are easiest for tests and embedded deployments. They never conflict: env vars set the defaults, and constructor options override per-instance.

## Runtime config (env vars)

All values are validated against `RuntimeConfigSchema` (`src/runtime-config.ts`) once at module load. **Out-of-bounds values throw at startup** rather than producing a broken cache size or negative timeout.

| Env var | Default | Bounds | Purpose |
| --- | --- | --- | --- |
| `AGENT_CONFIG_CACHE_TTL_MS` | `300000` (5 min) | 1s – 1h | TTL for cached agent configs in the factory |
| `MAX_AGENT_CONFIG_CACHE_SIZE` | `100` | 1 – 10,000 | Max cached agent configs |
| `FALLBACK_CONFIG_CACHE_TTL_MS` | `30000` (30s) | 1s – 1h | Shorter TTL for fallback configs so DB recovery is detected sooner |
| `AGENT_TIMEOUT_MS` | `120000` (2 min) | 1s – 1h | Timeout for a single agent LLM invocation |
| `MAX_MEMORY_PROMPT_BYTES` | `51200` (50 KB) | 1 KB – 10 MB | Max serialized memory injected into the system prompt |
| `MAX_MEMORY_VALUE_BYTES` | `1048576` (1 MB) | 1 KB – 100 MB | Max bytes for a single memory value; the reducer drops oversized values into `state.memory_drops` |
| `MAX_VISITED_NODES` | `1000` | 10 – 1,000,000 | Ring-buffer cap on `state.visited_nodes` |
| `MAX_SUPERVISOR_HISTORY` | `100` | 10 – 100,000 | Ring-buffer cap on `state.supervisor_history` |
| `MAX_MEMORY_DROPS` | `50` | 1 – 10,000 | Ring-buffer cap on `state.memory_drops` |
| `FILTREX_CACHE_SIZE` | `256` | 8 – 100,000 | LRU cap on the filtrex expression compile cache |
| `LOG_LEVEL` | `error` | `debug` \| `info` \| `warn` \| `error` \| `silent` | Minimum level the engine emits. Quiet by default so the package does not write to a host's stdout uninvited; raise it to see the full run trace. Resolved on first use, so it works whether set before launch or by a `.env` loader. |

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
| `registry` | `AgentRegistry` | process-global | Agent config source for this run. Scopes agents to the run so concurrent runs never share registry state. See the note below. |
| `providers` | `ProviderRegistry` | built-ins (Anthropic + OpenAI) | Provider registry for this run. Scopes providers alongside `registry`. |
| `persistState` | `(state: WorkflowState) => Promise<void>` | none | Persist a state snapshot after each step (wire to a `PersistenceProvider`) |
| `loadGraph` | `(graphId: string) => Promise<Graph \| null>` | none | Load subgraph definitions by ID |
| `eventLog` | `EventLogWriter` | in-memory (noop) | Append-only event log + checkpoints |
| `tools` | `Array<DefinedTool \| ToolResolver>` | none | Everything that provides tools: `defineTool()` results and MCP resolvers (`MCPConnectionManager` recommended) |
| `contextCompressor` | `ContextCompressor` | none | Compress memory before prompt injection |
| `memoryRetriever` | `MemoryRetriever` | none | Pull facts from the hierarchical memory graph. Only fires for nodes that declare a `memory_query` directive. |
| `memoryWriter` | `MemoryWriter` | none | Persist facts produced by `reflection` nodes. Required for reflection nodes to function. |
| `factSanitizer` | `FactSanitizer` | none | Pre-write hook applied to every reflection fact. Return `null` to drop, or a modified fact to substitute. **Fails closed**: a thrown sanitizer drops the fact (see `factSanitizerFailMode`). |
| `factSanitizerFailMode` | `'drop' \| 'pass'` | `'drop'` | What to do when `factSanitizer` throws. `'drop'` (default) discards the fact so unredacted PII is never persisted; `'pass'` writes the original fact (fail open). |
| `rateLimiter` | `RateLimiter` | none | Awaited before every LLM call (agent / supervisor / evaluator) to pace a run inside a provider's budget. The implementation may delay (throttle) or throw (a hard ceiling that surfaces as the node's error and follows its `failure_policy`). Abortable; propagated into subgraphs. |
| `compactionInterval` | `number` | `1000` | Events between automatic event-log compactions (checkpoint + delete-behind, recovery-safe) when an `eventLog` is wired. **Defaults on** so a long run can't grow the log unbounded; set `0` to retain full history and compact manually via `compactEvents()`. |
| `persistDelta` | `(patch: StatePatch) => Promise<void>` | none | Differential persistence. When set with `persistState`, the runner sends patches here and full snapshots to `persistState`. A failed write rolls back the delta baseline so no patch is lost. |
| `middleware` | `GraphRunnerMiddleware[]` | `[]` | `beforeNodeExecute` / `afterReduce` hooks |
| `a2aRegistry` | `A2AServerRegistry` | none | Trusted source of remote-agent endpoints and credentials. Required when the graph contains an `a2a` node; a graph names a `server_id`, never a URL. |
| `a2aClient` | `A2AClient` | none | Transport for A2A tasks. `createA2AClient()` from `@cycgraph/a2a` implements it; the orchestrator carries no protocol dependency. |
| `capabilityCeiling` | `CapabilityCeiling` | none | Caps what this runner may reach: tool resolution refuses custom names and MCP server ids outside it, and the startup wiring check rejects a graph referencing beyond it. See [Subgraph](/docs/patterns/subgraph/#trust-the-capability-ceiling). |
| `capabilityCeilings` | `Record<string, CapabilityCeiling>` | `{}` | Per-subgraph ceilings, keyed by subgraph id and derived from bundle manifests. Threaded down so a nested bundle is capped by the intersection of every enclosing manifest. |
| `logger` | `(entry: LogEntry) => void` | process streams | Destination for this run's log entries. Called after `LOG_LEVEL` filtering, so it never sees entries the level suppressed. A throwing sink cannot fail the run, and a returned promise is not awaited. Entries emitted outside a run keep going to the streams. |
| `allowImplicitCompletion` | `boolean` | `false` | When a non-end node has no outgoing edge whose condition matches, the runner fails the run with `NoMatchingEdgeError` (a dead-end is almost always a routing bug). Set `true` to restore the legacy behavior of silently completing the workflow at that node. |

Logging is off unless asked for, matching tracing and metrics. Route it into a
host transport with `logger`:

```typescript
new GraphRunner(graph, state, {
  logger: (entry) => pino[entry.level](entry.context, entry.event),
});
```

The former names `persistStateFn`, `loadGraphFn`, and `persistDeltaFn` remain as **deprecated aliases** of `persistState`, `loadGraph`, and `persistDelta`; the primary name wins when both are given, and the aliases will be removed in a later release.

A pre-flight wiring check runs at the start of every `run()`: a graph containing a `reflection` node with no `memoryWriter`, a node declaring MCP tool sources with no resolver on `tools`, or a custom tool source with no matching `defineTool()` registration, fails immediately (before any node executes) instead of mid-run. A `memory_query` directive with no `memoryRetriever` logs a warning.

Scope the agent registry and providers into the run via `registry` / `providers` so concurrent runs in one process never contaminate each other. The older process-global helpers `configureAgentFactory` / `configureProviderRegistry` are **deprecated** in favor of these options; they still work for single-tenant setups but mutate global state shared across every run.

The agent factory **fails closed** on an unknown `agent_id` (throws `AgentNotFoundError`). Opt into the legacy default-agent fallback with `configureAgentFactory(registry, { allowDefaultFallback: true })`. See [Agents](/docs/concepts/agents/#runtime-execution).

## `MCPConnectionManager` options

Source: `mcp/connection-manager.ts`.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `cache_ttl_ms` | `number` | `300000` (5 min) | TTL for cached tool manifests. `0` disables. |
| `default_tool_timeout_ms` | `number` | `30000` (30s) | Per-tool execution timeout. Overridable per-server via `MCPServerEntry.tool_timeout_ms`. |
| `default_max_concurrent_calls` | `number` | `0` (unlimited) | Default cap on concurrent tool calls **per MCP server**. Overridable per-server via `MCPServerEntry.max_concurrent_calls`. A FIFO semaphore bounds in-flight calls so a wide fan-out (evolution / voting / map candidates all hitting one server) can't overwhelm it. |
| `tool_circuit_breaker` | `ToolCircuitBreakerOptions \| null` | enabled with defaults | Per-tool breaker. Pass `null` to disable entirely. |

### `ToolCircuitBreakerOptions`

| Option | Default | Purpose |
| --- | --- | --- |
| `failure_threshold` | `5` | Consecutive failures that open the breaker |
| `success_threshold` | `2` | Consecutive successes in `half_open` to close |
| `cooldown_ms` | `30000` (30s) | Window the breaker stays `open` before transitioning to `half_open` |

Snapshot metrics via `manager.getToolCircuitMetrics()`, then wire to a `/metrics` endpoint or middleware.

## `DrizzleEventLogWriter` options

Source: `@cycgraph/orchestrator-postgres`.

| Option | Default | Purpose |
| --- | --- | --- |
| `retain_checkpoints` | `3` | How many checkpoints per run to keep. Older ones are pruned inside the same transaction as each new write. Minimum `1` enforced. |

## `InMemoryMemoryIndex` options

Source: `@cycgraph/memory`.

| Option | Default | Purpose |
| --- | --- | --- |
| `expectedDimensions` | unset | Strict dimension check: every embedding indexed or queried must match. Mismatch throws `EmbeddingDimensionMismatchError`. Wire from `EmbeddingProvider.dimensions`. |
| `silenceScaleWarning` | `false` | Suppress the one-shot console warning when the brute-force index crosses 10K entries. Set `true` only for stress tests. |

## Validation behavior

Misconfiguration **fails loud, not silent**:

- Setting `MAX_MEMORY_VALUE_BYTES=0` would silently drop every memory update. The Zod schema rejects it at startup with a descriptive error.
- Setting `retain_checkpoints=0` would orphan the run from any usable replay anchor. `DrizzleEventLogWriter` throws in its constructor.
- A 512-dim `EmbeddingProvider` talking to a 1536-dim `pgvector` schema produced silently wrong cosine scores. With `expectedDimensions` set, the first query throws.

Every default above is also the recommended starting point. Change one knob at a time, and watch for the symptom listed in [When to tune](#when-to-tune).
