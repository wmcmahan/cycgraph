---
"@cycgraph/orchestrator": patch
---

Stop retrying a failed node once the workflow has been cancelled or has timed out. Before this fix, `GraphRunner.cancel()` could be followed by fresh LLM calls from backoff retries, so `run()` kept going long after cancellation.
