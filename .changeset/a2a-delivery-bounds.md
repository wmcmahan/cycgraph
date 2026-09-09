---
"@cycgraph/a2a": minor
---

`timeoutMs` and `abortSignal` now bound the whole delivery — client construction, the blocking `message/send`, and every settle poll — with the signal threaded into the SDK transport's fetch. A remote that accepts the connection and stalls no longer hangs the node forever: a bound that fires mid-settle still returns the last observed task, and one that fires before any task exists throws a clear timeout or caller-abort error. `CreateSdkClient` gains an optional `signal` parameter (backward compatible).
