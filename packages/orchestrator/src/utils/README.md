# Utils — Technical Reference

> **Scope**: This document covers the generic helper modules in `@cycgraph/orchestrator/src/utils/`. Per the repo's placement rule, `utils/` holds helpers with no domain of their own; anything that belongs to a domain lives in that domain's directory. Several modules this README once covered moved out during the directory reorg — see [Relocated Modules](#relocated-modules) for where they went.

---

## Overview

| File | Purpose | Exported From |
|------|---------|---------------|
| [case-mapping.ts](case-mapping.ts) | camelCase ⇄ snake_case mapping for the public authoring layer | Public API (via `schemas.ts`) |
| [context.ts](context.ts) | AsyncLocalStorage run context for distributed log correlation | Public API |
| [condition-expression.ts](condition-expression.ts) | Shared filtrex options + expression normalization | `@cycgraph/orchestrator/internal` |
| [abort.ts](abort.ts) | `AbortSignal` combinator | Engine-internal |
| [concurrency.ts](concurrency.ts) | Bounded-concurrency async map | Engine-internal |

## Relocated Modules

These were documented here before the domain-oriented reorg. Their behavior is unchanged; they now live with their domains:

| Module | New Home | Domain |
|--------|----------|--------|
| `logger.ts` | [../observability/logger.ts](../observability/logger.ts) | Structured JSON logging |
| `tracing.ts` | [../observability/tracing.ts](../observability/tracing.ts) | OpenTelemetry tracing |
| `metrics.ts` | [../observability/metrics.ts](../observability/metrics.ts) | OpenTelemetry Prometheus metrics |
| `taint.ts` | [../security/taint.ts](../security/taint.ts) | Data provenance tracking |
| `lesson-provenance.ts` | [../memory/lesson-provenance.ts](../memory/lesson-provenance.ts) | Eval-gated learning attribution |
| `pricing.ts` | [../cost/pricing.ts](../cost/pricing.ts) | Per-model USD cost lookup |

---

## Case Mapping (`case-mapping.ts`)

The engine, database, and wire format use snake_case. Consumers author graphs, agents, workflow state, and MCP servers in idiomatic camelCase TypeScript. This module bridges the two, at both the type level and runtime. Snake_case remains the format the engine reads and the database stores; only the authoring surface is camelCase (coding standard #7).

### Type-Level

#### `SnakeToCamel<S extends string>`

Converts a snake_case string-literal type to camelCase.

#### `Camelize<T>`

Recursively rewrites an object type's keys from snake_case to camelCase, so authoring types are derived from the wire types and the two never drift:

- Arrays recurse into their element type.
- Index-signature records (`Record<string, X>`) pass through, so freeform maps like `metadata`, `memory`, and `weights` keep arbitrary user keys.
- Unions distribute, preserving discriminated config unions.
- `Date` and other built-ins pass through untouched.
- Optional and readonly modifiers are preserved.

### Runtime

#### `camelToSnakeDeep(value, opaqueKeys?): unknown`

Deep camel→snake key remap performed at each public constructor boundary: `createGraph`, `createWorkflowState`, `registry.register`, `saveServer`. It is **idempotent on snake_case keys**, so wire-format objects pass through unchanged and the constructors double as a back-compat path.

#### `DEFAULT_OPAQUE_KEYS`

Keys whose **values** are freeform or user-controlled and must never be key-converted: `metadata`, `weights`, `input_mapping`, `output_mapping`, `static_items`, `value`, `provider_options`, `memory`, `env`, `headers`, `inputs`, `outputs`. The field name itself is still snake-cased; the value is copied verbatim so user memory keys, provider options, env vars, and headers survive untouched. Keys are listed in snake_case, the form they take after the field name is converted, so both `providerOptions` and `provider_options` are covered.

#### `camelKeyToSnake(key): string`

Single-key conversion; a no-op on keys already in snake_case.

---

## Run Context (`context.ts`)

`AsyncLocalStorage`-based correlation metadata that propagates through async call chains so log entries carry it without explicit parameter threading.

### `RunContext`

| Field | Purpose |
|-------|---------|
| `run_id` | Unique workflow run identifier |
| `request_id` | Inbound HTTP request identifier |
| `api_key_id` | Authenticated API key identifier, for audit trails |
| `graph_id` | Graph being executed |
| `node_id` | Node whose execution this async chain belongs to |
| `logger` | Optional `LogSink` destination for this chain's log entries. Absent, entries go to the process streams. Async-local rather than global, so concurrent runs can log to different destinations without interfering |

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

## Condition Expressions (`condition-expression.ts`)

The filtrex compile options and expression normalization shared by the runtime evaluator ([../execution/routing/conditions.ts](../execution/routing/conditions.ts)), the verifier executor's `expression` variant, and the load-time graph validator. Living in `utils/` keeps the dependency direction downward for all three consumers.

**Invariant**: the validator and evaluator MUST use identical options and normalization, so `validateGraph()` rejects exactly the set of expressions that `evaluateCondition()` cannot evaluate.

Exported via the `@cycgraph/orchestrator/internal` subpath. The exports are filtrex-coupled and exposed only for first-party tooling and validation.

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

Shared compile options: dot access with optional chaining (`useDotAccessOperatorAndOptionalChaining`) plus the extra functions above.

### `normalizeConditionExpression(expression): string`

Applied identically at load time and runtime:
- Strips a leading `$.` (legacy JSONPath compatibility)
- Replaces single-quoted string literals with double quotes

---

## Abort Signals (`abort.ts`)

Engine-internal, not exported from either barrel.

### `combineAbortSignals(...signals): AbortSignal | undefined`

Combines multiple optional `AbortSignal`s into one that aborts when ANY of them aborts. Returns `undefined` when no signals are provided, the single signal when only one is present, and `AbortSignal.any([...])` otherwise.

Used to merge a workflow-level cancellation signal with a per-task timeout signal so a composite node's parallel sub-tasks actually abort the underlying LLM call on timeout instead of leaving it running.

---

## Concurrency (`concurrency.ts`)

Engine-internal, not exported from either barrel.

### `mapWithConcurrency(items, limit, fn): Promise<R[]>`

Maps `items` through an async `fn` with at most `limit` invocations in flight, preserving input order in the result array. Worker-pool design rather than fixed batches: a slow item doesn't stall the batch, because the next item starts as soon as any worker frees up. `limit` is clamped to ≥ 1 and capped at `items.length`; `fn` receives `(item, index)`.
