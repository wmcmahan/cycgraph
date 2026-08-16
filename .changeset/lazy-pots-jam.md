---
"@cycgraph/orchestrator": patch
---

MCP tool calls open their own span.

A tool call reported a `tool.call` span, but everything inside it — connection reuse, the per-server concurrency permit, the request itself — was one opaque block. `mcp.tool.call` now nests beneath it with `mcp.server_id` and `mcp.tool_name`, so time spent queueing behind a slow server is separable from the caller's tool call:

```
node.execute.tool
  tool.call       tool.name=lookup_record tool.node_id=fetch
    mcp.tool.call mcp.server_id=scenario-mcp mcp.tool_name=lookup_record
```
