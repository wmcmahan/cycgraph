# Utils — Technical Reference

> **Scope**: This document covers all utility modules in `@cycgraph/orchestrator/src/utils/`: logging, tracing, metrics, run context, taint tracking, lesson provenance, model pricing, condition expressions, and async helpers.

---

## Overview

| File | Purpose | Exported From |
|------|---------|---------------|
| `logger.ts` | Structured JSON logging with levels, context, and namespacing | Public API |
| `tracing.ts` | OpenTelemetry distributed tracing (opt-in via environment variable) | Public API |
| `metrics.ts` | OpenTelemetry Prometheus metrics (opt-in via `METRICS_ENABLED`) | Public API |
| `context.ts` | AsyncLocalStorage run context for distributed log correlation | Public API |
| `taint.ts` | Data provenance tracking for external tool results | Public API |
| `lesson-provenance.ts` | Registry of memory facts injected into prompts (eval-gated learning) | Public API (read helpers) |
| `pricing.ts` | Per-model USD cost lookup for budget enforcement and usage tracking | Public API |
| `condition-expression.ts` | Shared filtrex options + expression normalization | `@cycgraph/orchestrator/internal` |
| `abort.ts` | `AbortSignal` combinator | Engine-internal |
| `concurrency.ts` | Bounded-concurrency async map | Engine-internal |

---

## Logger (`logger.ts`)

Structured logging. All output is JSON, written to `stdout` (info/debug) or `stderr` (warn/error).

### `createLogger(component, context?): Logger`

Factory function that creates a namespaced logger instance.

```typescript
import { createLogger } from '@cycgraph/orchestrator';

const log = createLogger('runner.graph');
log.info('workflow_started', { workflow_id: 'abc', run_id: '123' });
// {
//   "timestamp": "...",
//   "level": "info",
//   "event": "runner.graph.workflow_started",
//   "context": {
//     "workflow_id": "abc",
//     "run_id": "123"
//   }
// }
```

### Logger Class

| Method | Signature | Output |
|--------|-----------|--------|
| `debug(event, context?)` | `(string, Record?) → void` | Lowest priority, filtered by default |
| `info(event, context?)` | `(string, Record?) → void` | Standard operational events |
| `warn(event, context?)` | `(string, Record?) → void` | Suspicious but non-fatal conditions |
| `error(event, error?, context?)` | `(string, Error?, Record?) → void` | Errors with optional stack trace |
| `child(context)` | `(Record) → Logger` | Creates a child logger with merged default context |

### Log Level Filtering

Controlled by `LOG_LEVEL` environment variable. Priority order: `debug < info < warn < error`. Default: `info`.

### Log Entry Format

```typescript
{
  timestamp: string;  // ISO 8601
  level: LogLevel;    // 'debug' | 'info' | 'warn' | 'error'
  event: string;      // "{component}.{event}" namespaced
  context?: Record;   // Structured metadata
}
```

### Namespaces Used in the Codebase

| Namespace | Component |
|-----------|-----------|
| `runner.graph` | GraphRunner core |
| `runner.conditions` | Edge condition evaluation |
| `runner.parallel` | Parallel executor |
| `runner.node.*` | Node executors (agent, tool, supervisor, etc.) |
| `agent.executor` | Agent executor |
| `agent.factory` | Agent factory |
| `agent.evaluator` | Evaluator executor |
| `agent.supervisor` | Supervisor executor |
| `architect` | Workflow architect |
| `architect.tools` | Architect tool handlers |
| `db.persistence` | State persistence |
| `mcp.gateway` | MCP gateway client |
| `mcp.tools` | Tool adapter |
| `mcp.schema` | JSON schema converter |

---

## Tracing (`tracing.ts`)

OpenTelemetry distributed tracing with OTLP HTTP export. **Opt-in** — when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, all tracing is a no-op with zero overhead.

### `initTracing(serviceName): Promise<void>`

Must be called once at application startup, before any traced code runs. Dynamically imports OTel packages only when tracing is enabled.

```typescript
import { initTracing } from '@cycgraph/orchestrator';

await initTracing('orchestrator');
// Traces sent to: ${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces
```

Registers SIGTERM/SIGINT handlers for graceful shutdown of the trace exporter.

### `getTracer(name): Tracer`

Returns a named tracer instance. Returns a no-op tracer if OTel is not initialized, so callers never need to check if tracing is enabled.

```typescript
const tracer = getTracer('runner.graph');
```

### `withSpan(tracer, name, fn, attributes?): Promise<T>`

Executes an async function within a new span. Automatically:
- Creates a child span under the current context
- Sets span status to `OK` on success, `ERROR` on exception
- Records exceptions on the span
- Ends the span when the function completes

```typescript
const result = await withSpan(tracer, 'workflow.run', async (span) => {
  span.setAttribute('workflow.id', workflowId);
  // ... do work ...
  return finalState;
});
```

### Span Hierarchy

```
workflow.run (3.2s) — workflow_id, graph_name, status
├── node.execute.supervisor (120ms) — decision: research, reasoning: "..."
├── node.execute.agent (1.8s)
│   └── agent.execute — model: claude-sonnet-4, tokens: 1200/450
├── node.execute.supervisor (95ms) — decision: writer
└── node.execute.supervisor (80ms) — decision: __done__
```

### Re-exports

`SpanStatusCode`, `context`, `Span` from `@opentelemetry/api` for convenience.

---

## Taint Tracking (`taint.ts`)

Data provenance system that tracks which memory keys contain external (untrusted) data. The taint registry is stored at `memory._taint_registry`.

### Functions

#### `markTainted(memory, key, meta): void`

Marks a memory key as tainted with source metadata. Mutates the memory object's `_taint_registry`.

```typescript
markTainted(state.memory, 'search_results', {
  source: 'mcp_tool',
  tool_name: 'web_search',
  created_at: new Date().toISOString(),
});
```

#### `isTainted(memory, key): boolean`

Checks if a memory key is tainted.

#### `getTaintRegistry(memory): TaintRegistry`

Returns the full taint registry. Returns empty object `{}` if no registry exists.

#### `getTaintInfo(memory, key): TaintMetadata | undefined`

Gets taint metadata for a specific key.

#### `propagateDerivedTaint(memory, outputKeys, agentId): TaintRegistry`

Propagates taint from input memory to output keys. If any of the agent's readable memory keys are tainted, all output keys are marked as `derived` tainted.

Returns only the new entries (not the full registry). The caller merges these into the existing registry.

### Taint Sources

| Source | When Applied |
|--------|-------------|
| `mcp_tool` | MCP tool adapter wraps all external tool results |
| `tool_node` | Tool node executor propagates from tool results |
| `agent_response` | Agent output from external-data-influenced execution |
| `derived` | Any output produced from tainted inputs |

### Protection

The `_taint_registry` key is protected by the agent executor's rule that blocks writes to keys starting with `_`. Agents cannot tamper with their own taint status.

---

## Metrics (`metrics.ts`)

OpenTelemetry Prometheus metrics. **Opt-in** — enabled only when `METRICS_ENABLED=true`; otherwise every recording function is a zero-cost no-op (instruments stay `undefined`). OTel packages are dynamically imported only when enabled.

### `initMetrics(): Promise<void>`

Must be called before any recording. Idempotent — safe to call multiple times.

```typescript
import { initMetrics, collectMetrics } from '@cycgraph/orchestrator';

await initMetrics();
```

### Instruments

| Metric | Type | Purpose |
|--------|------|---------|
| `mcai_workflows_started_total` | Counter | Workflows started |
| `mcai_workflows_completed_total` | Counter | Workflows completed successfully |
| `mcai_workflows_failed_total` | Counter | Workflows that failed |
| `mcai_tokens_used_total` | Counter | LLM tokens consumed |
| `mcai_cost_usd_total` | Counter | LLM cost in USD |
| `mcai_workflow_duration_ms` | Histogram | Workflow execution duration |
| `mcai_agent_duration_ms` | Histogram | Agent node execution duration |
| `mcai_queue_depth` | ObservableGauge | Jobs in the workflow queue (waiting + active) |

### Recording Functions

`incrementWorkflowsStarted`, `incrementWorkflowsCompleted`, `incrementWorkflowsFailed`, `recordTokensUsed`, `recordCostUsd`, `recordWorkflowDuration`, `recordAgentDuration` — each takes an optional `labels` record.

### `setQueueDepthProvider(fn): void`

Registers an async callback that returns the current queue depth. Called from the API layer where queue access is available; failures are swallowed (best effort).

### `collectMetrics(): Promise<{ contentType, metrics } | null>`

Serializes current metrics in Prometheus text format for a `/metrics` endpoint. Returns `null` when metrics are disabled.

---

## Run Context (`context.ts`)

`AsyncLocalStorage`-based correlation metadata (`run_id`, `request_id`, `api_key_id`, `graph_id`) that propagates through async call chains so log entries carry it without explicit parameter threading.

### `runWithContext(ctx, fn): Promise<T>`

Executes `fn` within the given `RunContext`; all async operations it initiates see the context.

```typescript
import { runWithContext, getCurrentContext } from '@cycgraph/orchestrator';

await runWithContext({ run_id: 'abc', graph_id: 'g1' }, async () => {
  // anywhere down the call chain:
  const ctx = getCurrentContext(); // { run_id: 'abc', graph_id: 'g1' }
});
```

### `getCurrentContext(): RunContext`

Returns the current context, or `{}` outside a `runWithContext` scope.

> **Note**: `AsyncLocalStorage` does NOT propagate across `fork()` boundaries. Child processes must receive the context via IPC and call `runWithContext` at startup.

---

## Lesson Provenance (`lesson-provenance.ts`)

Manages the registry at `memory._lesson_provenance`: one entry per retrieval event, recording which memory facts were injected into which node's prompt. This is the attribution half of eval-gated learning — after a run, the injected fact IDs are fed to an outcome ledger (`@cycgraph/memory`) so lessons can be promoted or evicted on evidence.

Like `_taint_registry`, the `_` prefix keeps the registry out of every node's StateView and exempts it from write-permission validation. Entries are minted at action-creation time (not reducer time), so event-log replay reproduces them verbatim.

### Public API (read helpers)

#### `getInjectedFactIds(state): string[]`

The deduplicated set of fact IDs injected into prompts during a run — the value to pass as `fact_ids` when recording the run's outcome. Deterministic order (first occurrence in entry order).

```typescript
import { getInjectedFactIds } from '@cycgraph/orchestrator';

const finalState = await runner.run();
await ledger.recordOutcome({ run_id, score, fact_ids: getInjectedFactIds(finalState) });
```

#### `getLessonProvenance(state): LessonProvenanceEntry[]`

All provenance entries for a run, oldest first (total order: `retrieved_at`, then entry key — stable across replays).

#### `getLessonProvenanceRegistry(memory): LessonProvenanceRegistry`

Raw registry from a memory object. Returns `{}` when absent or malformed.

### Engine-Internal Functions

| Function | Used By | Purpose |
|----------|---------|---------|
| `mintLessonProvenance(retrieved, origin)` | Agent + supervisor executors | Mint a registry entry for facts injected into a node's prompt. Only facts whose retriever supplied an `id` are attributable; returns `undefined` when none were. |
| `mergeLessonProvenanceIntoMemory(memory, incoming)` | `handoff` / `set_status` reducers | Append-only merge + trim for actions that carry provenance outside the memory-updates channel. Pure and deterministic. |
| `trimLessonProvenance(registry)` | Reducers | Ring-buffer cap: keeps the newest `MAX_LESSON_PROVENANCE_ENTRIES` (256) entries. |

> **REPLAY WARNING**: `MAX_LESSON_PROVENANCE_ENTRIES` and the trim's total order participate in event-log replay. Changing either changes replayed state — bump `REPLAY_VERSION` in `reducers/index.ts` if you do.

---

## Model Pricing (`pricing.ts`)

Per-model cost lookup used by the cost tracking reducer and budget enforcement. Prices are in **USD per 1 million tokens**.

### `calculateCost(model, inputTokens, outputTokens): number`

Returns the estimated cost in USD — always finite and ≥ 0.

```typescript
import { calculateCost } from '@cycgraph/orchestrator';

const cost = calculateCost('claude-sonnet-4-20250514', 1200, 450);
```

- **Unknown models**: returns `0` (graceful degradation — cost tracking continues) and logs `unknown_model_pricing` once per model. The warned-model set is capped at 1000 entries so varied unknown IDs can't grow it unbounded.
- **Malformed token counts**: `NaN`/negative/infinite counts are coerced to `0` first. This matters for budget enforcement: a `NaN` cost would make every `cost > budget` comparison `false` and permanently disable the USD budget.

### `MODEL_PRICING: Record<string, ModelPricing>`

The pricing table (`{ inputPerMToken, outputPerMToken }`). Covers OpenAI, Anthropic, and Ollama/local models (priced at 0). Add new entries here when onboarding additional models.

---

## Condition Expressions (`condition-expression.ts`)

The filtrex compile options and expression normalization shared by the runtime evaluator (`runner/conditions.ts`), the verifier executor's `expression` variant, and the load-time graph validator. Lives in `utils/` so the dependency direction stays downward — `validation/` must not import from `runner/`.

**Invariant**: the validator and evaluator MUST use identical options and normalization, so `validateGraph()` rejects exactly the set of expressions that `evaluateCondition()` cannot evaluate.

Exported via the `@cycgraph/orchestrator/internal` subpath (filtrex-coupled; exposed only for tooling/validation).

### `FILTREX_EXTRA_FUNCTIONS`

Extra functions available inside condition expressions:

| Function | Behavior |
|----------|----------|
| `length(val)` | Array or string length; `0` otherwise |
| `lower(val)` / `upper(val)` | Case conversion for strings; passthrough otherwise |
| `typeof(val)` | `typeof`, with `null` reported as `'null'` |
| `includes(arr, val)` | `Array.includes`; `false` for non-arrays |
| `number(val)` | `Number(val)`, with `NaN` coerced to `0` |

### `FILTREX_COMPILE_OPTIONS`

Shared compile options: dot access + optional chaining (`useDotAccessOperatorAndOptionalChaining`) plus the extra functions above.

### `normalizeConditionExpression(expression): string`

Applied identically at load time and runtime:
- Strips a leading `$.` (legacy JSONPath compatibility)
- Replaces single-quoted string literals with double quotes

---

## Abort Signals (`abort.ts`)

Engine-internal (not exported from either barrel).

### `combineAbortSignals(...signals): AbortSignal | undefined`

Combines multiple optional `AbortSignal`s into one that aborts when ANY of them aborts. Returns `undefined` when no signals are provided, the single signal when only one is present, and `AbortSignal.any([...])` otherwise.

Used to merge a workflow-level cancellation signal with a per-task timeout signal so a composite node's parallel sub-tasks actually abort the underlying LLM call on timeout instead of leaving it running.

---

## Concurrency (`concurrency.ts`)

Engine-internal (not exported from either barrel).

### `mapWithConcurrency(items, limit, fn): Promise<R[]>`

Maps `items` through an async `fn` with at most `limit` invocations in flight, preserving input order in the result array. Worker-pool design (not fixed batches): a slow item doesn't stall the batch — the next item starts as soon as any worker frees up. `limit` is clamped to ≥ 1; `fn` receives `(item, index)`.
