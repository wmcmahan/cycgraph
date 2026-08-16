---
"@cycgraph/orchestrator": major
---

Metrics renamed off the `mcai_` prefix, onto domain names with correct units.

| Was | Now |
| --- | --- |
| `mcai_workflows_started_total` / `_completed_` / `_failed_` | `workflow.runs`, dimensioned by `status` |
| `mcai_tokens_used_total` | `workflow.tokens` |
| `mcai_cost_usd_total` | `workflow.cost` |
| `mcai_workflow_duration_ms` | `workflow.run.duration`, in seconds |
| `mcai_agent_duration_ms` | `gen_ai.client.operation.duration`, in seconds |
| `mcai_queue_depth` | `workflow.queue.depth` |

`mcai` was the name before `cycgraph`, and the metric names outlived it — which is the argument against putting a product name in a metric name at all rather than for updating it. The meter is scoped to `@cycgraph/orchestrator`, which the Prometheus exporter emits as an `otel_scope_name` label on every series, so the library is identified without spending the name on it.

Three lifecycle counters that differed by one word became one counter with a `status` dimension. Durations record seconds rather than milliseconds, per OTel convention; the recording functions still take milliseconds and convert, so callers are unchanged. Units are UCUM annotations (`{run}`, `{token}`, `{USD}`, `{job}`).

`gen_ai.client.operation.duration` adopts OpenTelemetry's GenAI semantic convention, which this measurement already matched: one observation per model call. That convention is experimental upstream. Token usage did **not** move to `gen_ai.client.token.usage`, because it is recorded once per run as a total rather than per model call, and feeding a run total to a per-operation histogram would make the distribution meaningless.

Anything scraping the old names must be updated. Metrics are gated behind `METRICS_ENABLED=true`, so deployments that never set it are unaffected.
