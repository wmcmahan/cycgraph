---
title: Tracing
description: Opt-in OpenTelemetry distributed tracing for workflow execution.
---

cycgraph includes **opt-in OpenTelemetry tracing** that gives you full visibility into workflow execution — node timings, LLM calls, supervisor decisions, and tool invocations. When tracing is disabled (the default), all tracing code is a no-op with zero overhead.

## Quick start

### 1. Initialize at startup

Call `initTracing()` once before any traced code runs:

```typescript
import { initTracing } from '@cycgraph/orchestrator';

await initTracing('my-app');
```

### 2. Set the endpoint

Tracing activates when the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable is set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node app.js
```

When the variable is unset, `initTracing()` returns immediately — OpenTelemetry modules are never imported (dynamic imports), so there is zero bundle or runtime cost.

### 3. View traces

cycgraph ships with a Jaeger service in Docker Compose:

```bash
docker compose up jaeger
open http://localhost:16686
```

Any OTLP-compatible collector works: **Jaeger**, **Axiom**, **Honeycomb**, **Grafana Tempo**, **LangFuse**, or your own.

## Span hierarchy

Every workflow run produces a tree of spans that maps directly to the execution flow:

```
workflow.run
├── node.execute.supervisor
│   └── supervisor.route          (one per routing decision)
├── node.execute.agent
│   └── agent.execute             (one per LLM call)
├── node.execute.evolution
│   └── evaluator.evaluate        (one per candidate evaluation)
└── node.execute.tool
```

Each `node.execute.*` span captures the node ID and type. Child spans add execution-specific detail.

:::note
When using `runner.stream()`, node-level spans are skipped to avoid interfering with real-time token delivery. Use event listeners (`node:start`, `node:complete`) for streaming observability instead.
:::

## Span attributes

### `workflow.run`

| Attribute | Type | Description |
|-----------|------|-------------|
| `workflow.id` | string | Workflow ID |
| `graph.id` | string | Graph definition ID |
| `graph.name` | string | Graph name |
| `run.id` | string | Unique run ID |
| `workflow.duration_ms` | number | Total wall-clock duration |
| `workflow.status` | string | Final status (`completed`, `failed`, etc.) |
| `workflow.iterations` | number | Total graph iterations executed |

### `agent.execute`

| Attribute | Type | Description |
|-----------|------|-------------|
| `agent.id` | string | Agent UUID |
| `agent.model` | string | Model ID (e.g. `claude-sonnet-4-20250514`) |
| `agent.provider` | string | Provider name (e.g. `anthropic`) |
| `agent.attempt` | number | Retry attempt (1 = first try) |
| `agent.duration_ms` | number | LLM call duration |
| `agent.tokens.input` | number | Input tokens consumed |
| `agent.tokens.output` | number | Output tokens generated |
| `agent.tokens.total` | number | Total tokens |
| `agent.tools_called` | number | Number of tool invocations |
| `agent.error` | string | Error message (on failure only) |

### `supervisor.route`

| Attribute | Type | Description |
|-----------|------|-------------|
| `supervisor.id` | string | Supervisor node ID |
| `supervisor.decision` | string | Chosen next node (or `__done__`) |
| `supervisor.reasoning` | string | LLM's explanation for the routing choice |
| `supervisor.iteration` | number | Current supervisor iteration |
| `supervisor.input_tokens` | number | Input tokens consumed |
| `supervisor.output_tokens` | number | Output tokens generated |

### `evaluator.evaluate`

| Attribute | Type | Description |
|-----------|------|-------------|
| `evaluator.agent_id` | string | Evaluator agent UUID |
| `evaluator.score` | number | Quality score (0.0–1.0) |
| `evaluator.tokens` | number | Total tokens consumed |

## Using tracers in custom code

If you build custom node executors or utilities, you can create spans using the exported helpers:

```typescript
import { getTracer, withSpan } from '@cycgraph/orchestrator';

const tracer = getTracer('my-custom-module');

const result = await withSpan(tracer, 'my.operation', async (span) => {
  span.setAttribute('my.custom_attr', 'value');
  // ... your logic ...
  return someResult;
});
```

`withSpan` automatically:
- Creates a child span under the current async context
- Sets span status to `OK` on success
- Sets span status to `ERROR` and records the exception on failure
- Ends the span in a `finally` block (guaranteed cleanup)

`getTracer()` returns a no-op tracer when OpenTelemetry is not initialized, so your code works identically with or without tracing enabled.

## Metrics

`initTracing()` also initializes an optional metrics subsystem (gated separately by `METRICS_ENABLED=true`). Built-in metric recording functions:

| Function | What it records |
|----------|----------------|
| `recordWorkflowDuration(ms)` | Workflow wall-clock time |
| `recordTokensUsed(count)` | Token consumption |
| `recordCostUsd(amount)` | Dollar cost |
| `recordAgentDuration(ms)` | Per-agent LLM call time |
| `incrementWorkflowsStarted()` | Workflow start counter |
| `incrementWorkflowsCompleted()` | Workflow completion counter |
| `incrementWorkflowsFailed()` | Workflow failure counter |

All metric functions accept optional labels and are zero-cost no-ops when metrics are disabled.

## Graceful shutdown

`initTracing()` registers `SIGTERM` and `SIGINT` handlers that flush pending spans and shut down the SDK cleanly. No additional cleanup code is needed.

## Next steps

- [Evaluations](/docs/observability/evals/) — verify agent behavior with automated eval suites
- [Streaming](/docs/concepts/streaming/) — real-time event observability (alternative to spans)
