---
"@cycgraph/orchestrator": minor
---

Log entries now carry `trace_id` and `span_id` when tracing is active.

`LogEntry` gained two optional top-level fields, populated from the active span. They are the join key between logs and traces: a line can be traced back to the operation that emitted it, and a trace can be expanded into the lines it produced. Both are absent rather than zero-filled when tracing is off, so an all-zero id that joins to nothing never reaches a sink.

This is additive. Existing sinks keep working, and hosts that forward to a log aggregator can now correlate against whatever collector receives the spans.
