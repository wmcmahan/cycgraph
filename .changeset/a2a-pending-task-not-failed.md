---
"@cycgraph/a2a": patch
---

A remote task still `submitted`/`working` when `max_wait_ms` runs out or the run is aborted is no longer reported as `failed`; the delivery now rejects with a non-retryable `A2ATaskPendingError` carrying the task id, so the node's failure policy no longer starts a duplicate remote task while the first keeps running.
