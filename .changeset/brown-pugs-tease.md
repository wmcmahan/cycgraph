---
"@cycgraph/orchestrator": minor
---

Added `withRemoteTraceContext`, and exported it alongside `injectTraceContext` from the package root.

`injectTraceContext` could put a trace context onto an outbound carrier, but nothing could read one back, so a process started by a traced parent began a trace of its own. `withRemoteTraceContext(carrier, fn)` runs `fn` under the context a carrier holds, which makes spans created inside it children of the span the carrier came from. A worker calls it around its work with `process.env`; an HTTP handler calls it with the request headers.

Both are no-ops when the carrier holds no trace context, so a callee can use it unconditionally whether or not its caller was traced.
