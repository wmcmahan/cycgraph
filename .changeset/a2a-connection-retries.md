---
"@cycgraph/orchestrator": patch
"@cycgraph/a2a": patch
---

Honor the A2A registry entry's `max_retries`: the `a2a` node now forwards it to the client, and `@cycgraph/a2a` retries a failed connection (Agent Card resolution and client construction) with exponential backoff within the task timeout. `message/send` is never retried, because a resend could start the remote task twice.
