---
"@cycgraph/orchestrator": patch
---

A mid-stream provider error (an HTTP 413, a rate limit, a network drop) surfaced through `onError` no longer masquerades as a silent finish. The AI SDK resolves the awaited result promises after such an error, so the executor previously fell into the empty-final recovery path, re-sent the dead transcript, and returned an empty turn the graph treated as success. The error now throws into the executor's failure path, where it is classified for retry and its partial usage is accounted.
