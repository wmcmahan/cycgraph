---
"@cycgraph/a2a": patch
---

Keep a `Request` input's own headers (such as `Content-Type` and `Accept`) on every A2A request hop, including redirect replays. Before this fix, fetch dropped them because the per-server headers were always passed through `init.headers`. The merge order is now the `Request`'s headers, then the SDK's `init.headers`, then the per-server headers.
