---
"@cycgraph/orchestrator": patch
---

`runTool` returns its result key, like the tool node it builds.

`node({ type: 'tool' })` carried `.result`; `runTool`, which builds the same node, did not. Both now do.
