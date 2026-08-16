---
"@cycgraph/orchestrator": minor
---

A `tool` node now reports the call it makes.

Only agent-initiated tool calls emitted `tool:call_start` and `tool:call_finish`. A standalone `tool` node — the deterministic path that reaches real MCP servers — emitted neither, and opened no span, so a tool call appeared in a trace as an empty `node.execute.tool` with no duration, arguments, or error inside it.

Tool nodes now emit both events and open a `tool.call` span carrying `tool.name`, `tool.call_id`, `tool.node_id`, and `tool.arg_keys`. A tool that returns `isError` still does not fail the node, so the finish event carries the tool's own verdict rather than the node's: `success: false` on an errored result that the run continues past.
