---
"@cycgraph/studio": patch
---

The playground's scenario MCP server is now registered with a 35s connection timeout instead of 30s, strictly above the `slow` tool's 30s sleep cap. A scenario calling `slow(ms: 30000)` now reliably trips the engine's per-tool timeout instead of racing a transport-level connection abort.
