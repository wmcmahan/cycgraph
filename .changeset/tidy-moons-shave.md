---
"@cycgraph/orchestrator": patch
---

`shutdownTracing()` now releases the global tracer provider registration, so a later `initTracing()` starts a live exporter.

OpenTelemetry refuses to overwrite a tracer provider that is already registered globally. Because `shutdownTracing()` reset its own `initialized` flag without releasing that registration, a process that shut tracing down and initialized it again silently kept the stopped provider: spans were created and carried plausible trace ids, but the exporter behind them was closed and nothing reached the collector.

This affects any long-running host that scopes tracing to a unit of work rather than to the process. A run would record a trace id that returns 404 in Jaeger.
