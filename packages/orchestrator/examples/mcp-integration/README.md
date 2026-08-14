# MCP Integration

Agents calling tools hosted by MCP servers. `registerDefaultMCPServers()` sets
up the two reference servers in one line, and an agent declares what it wants
with `{ mcp: 'server-id' }` in its `tools` array.

Everything those servers return is treated as external data and taint-tracked,
which is the point of the example as much as the tool calls are.

## Graph

```
research  → research_notes   (tools: web-search, fetch)
   └── write → summary
```

The MCP servers are not nodes. They are tool sources an agent resolves through
the `MCPConnectionManager` wired onto the runner.

## Lifecycle & State

| Key | Written by | Notes |
| --- | --- | --- |
| `research_notes` | research | tainted: derived from MCP tool output |
| `summary` | write | tainted: derived from `research_notes` |
| `taint_registry` | engine | records the source server for each key |

Taint propagates forward. A key derived from external data stays marked, so a
downstream taint-gated action still sees it.

## Run

Needs a Brave Search key on top of the model credentials:

```bash
BRAVE_API_KEY=BSA-... ANTHROPIC_API_KEY=sk-ant-... \
  npx tsx examples/mcp-integration/mcp-integration.ts
```

The servers start as child processes over stdio: web search is an npm package
run through `npx`, fetch is a Python package run through `uvx`. Both are
resolved on first use, so the first run is slower.

## Expected Output

```
Tool called: brave_web_search
Tool called: fetch

═══ Notes ═══
- …

Taint registry: { research_notes: { source: 'mcp', server_id: 'web-search' }, … }
```

## Notes

**Why an explicit `GraphRunner`.** The example inspects the final
`WorkflowState` for the taint registry and visited nodes, and attaches
tool-call listeners, none of which the one-call `run()` helper exposes.

**Trusted registry.** Server transport configs live in an
`MCPServerRegistry`, never inline in the graph. Stdio commands are restricted
to an allowlist and http/sse URLs are SSRF-guarded, re-validated on every read
and write. A graph names a server id; it cannot name an arbitrary command.
