---
"@cycgraph/orchestrator": patch
---

Reflection nodes extend best-effort handling to the memory writer: a store or I/O failure while persisting extracted facts rethrows while the node has retries left and degrades to zero facts on the final attempt — the result envelope carries `writer_failed: true` — instead of failing a run whose productive work already succeeded. A missing `memoryWriter` (configuration) still fails loudly.
