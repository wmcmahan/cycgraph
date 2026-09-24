---
"@cycgraph/orchestrator": patch
"@cycgraph/a2a": patch
---

The A2A registry entry's `timeout_ms` is now enforced: the `a2a` node passes it as `requestTimeoutMs`, and `@cycgraph/a2a` applies it to each connection attempt, `message/send`, and status poll on its own. A remote that stalls one call now fails fast instead of holding the node for the full `task_timeout_ms`.
