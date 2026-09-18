---
"@cycgraph/orchestrator": patch
"@cycgraph/orchestrator-postgres": patch
---

`listServers()` now re-validates every stored MCP server entry through `MCPServerEntrySchema`, matching `loadServer()`. A tampered or migrated-in row with a disallowed stdio command or an SSRF-prone URL makes the call throw instead of being returned to callers.
