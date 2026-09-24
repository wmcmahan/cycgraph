---
"@cycgraph/orchestrator": patch
"@cycgraph/a2a": patch
---

The A2A registry entry's `timeout_ms` is now enforced: the `a2a` node passes it as `requestTimeoutMs`, and `@cycgraph/a2a` applies it to each connection attempt and status poll on its own. A remote that stalls one of those calls now fails fast instead of holding the node for the full `task_timeout_ms`; the blocking `message/send` stays bounded by `task_timeout_ms` only, so long-running remote tasks are unaffected.
