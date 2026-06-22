---
title: Tools & MCP
description: How agents interact with external systems via tool sources and the Model Context Protocol.
---

Agents need tools to interact with the world. cycgraph uses structured **tool sources** and the **Model Context Protocol (MCP)** for secure, standardized tool integration. This decouples the agent definition from the underlying transport configuration and connection secrets.

## Tool source types

Agents declare their tools using a `ToolSource[]` array with two possible types:

1. **Built-in tools**: Provided by the orchestrator itself. No external connection needed.
2. **MCP tools**: Provided by a registered MCP server. References the server by ID.

```typescript
import { InMemoryAgentRegistry } from '@cycgraph/orchestrator';

const agentRegistry = new InMemoryAgentRegistry();

const RESEARCH_AGENT = agentRegistry.register({
  name: 'Research Specialist',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You are a research specialist...',
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', serverId: 'web-search' }
  ],
});
```

:::note
The `save_to_memory` tool is **opt-in**. The orchestrator automatically captures agent text output and routes it to the node's write key, so single-key agents don't need it. Declare `save_to_memory` explicitly only when an agent needs to write structured data to **multiple** memory keys.
:::

```typescript
// Single-key agent — no save_to_memory needed
const WRITER = agentRegistry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You write clear summaries.',
  tools: [],
  permissions: { readKeys: ['notes'], writeKeys: ['draft'] },
});
```

Optionally, you can filter to specific tools from an MCP server by providing `toolNames`:

```typescript
{
  type: 'mcp',
  serverId: 'web-search',
  toolNames: ['search', 'fetch']
}
```

### Node-level tool overrides

Graph nodes can override an agent's configured tools for a specific execution step. This lets you reuse the same general-purpose agent with different contextual tool sets throughout a graph.

```typescript
{
  id: 'initial-research',
  type: 'agent',
  agentId: RESEARCH_AGENT,
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', serverId: 'web-search' },
    { type: 'mcp', serverId: 'twitter-search' }
  ],
  readKeys: ['goal'],
  writeKeys: ['initial_notes'],
}
```

In this example, `save_to_memory` is included because the node may need to write structured data to multiple keys. For nodes that write to a single key, you can omit it — the orchestrator captures text output automatically.

## MCP Server Registry

The **trusted MCP Server Registry** holds transport configurations and connection secrets. This is the security boundary — agents reference servers by ID, but never see connection details.

### Registering servers

```typescript
import { InMemoryMCPServerRegistry } from '@cycgraph/orchestrator';

const mcpRegistry = new InMemoryMCPServerRegistry();

// HTTP transport
mcpRegistry.register({
  id: 'web-search',
  name: 'Web Search',
  description: 'Search the web via Brave Search API',
  transport: {
    type: 'http',
    url: 'https://mcp.example.com/web-search',
    headers: {
      'Authorization': `Bearer <API_KEY>`,
    },
  },
});

// Stdio transport (local MCP server)
mcpRegistry.register({
  id: 'code-executor',
  name: 'Code Executor',
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@mcp/code-sandbox'],
    env: { SANDBOX_TIMEOUT: '30000' },
  },
});

// SSE transport
mcpRegistry.register({
  id: 'slack-tools',
  name: 'Slack Integration',
  transport: {
    type: 'sse',
    url: 'https://mcp.example.com/slack/sse',
  },
  timeoutMs: 60_000,
});
```

*(Note: For production environments, use `DrizzleMCPServerRegistry` from `@cycgraph/orchestrator-postgres` to store server configurations durably in the database.)*

### Transport types

| Transport | Use case | Security |
|-----------|----------|----------|
| `stdio` | Local MCP server processes | Command allowlist: `npx`, `node`, `python3`, `python`, `uvx` |
| `http` | Remote MCP servers (stateless) | SSRF-guarded URLs (no private/loopback/metadata hosts) |
| `sse` | Remote MCP servers (streaming) | SSRF-guarded URLs (no private/loopback/metadata hosts) |

Every entry is re-validated through `MCPServerEntrySchema` on **both** `saveServer` and `loadServer`, so the command allowlist and SSRF guard are enforced even against a direct DB write, a migration, or an `any`-typed caller — not just at compile time. http/sse URLs that resolve to private, loopback, link-local, or cloud-metadata addresses are rejected; set `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true` to allow them in local development.

Each `MCPServerEntry` also supports the following optional fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutMs` | `number` | — | Connection-level timeout for the MCP transport |
| `toolTimeoutMs` | `number` | — | Per-tool-call execution timeout (overrides manager default) |
| `maxRetries` | `number` | `2` | Number of connection retry attempts with exponential backoff |
| `allowedAgents` | `string[]` | — | Restrict which agents can access this server |

### Access control

You can restrict which agents are allowed to use a specific server with the `allowedAgents` field:

```typescript
mcpRegistry.register({
  id: 'admin-tools',
  name: 'Admin Tools',
  transport: { type: 'http', url: 'https://internal.example.com/admin' },
  allowedAgents: ['admin-agent-001', 'ops-agent-002'],
});
```

When `allowedAgents` is set, only the listed agents can resolve tools from that server. Omit the field for unrestricted access.

### Connection resilience

The `MCPConnectionManager` includes built-in resilience features for production reliability:

**Connection retry with backoff**: Failed connections are automatically retried with exponential backoff. Configure `maxRetries` on each server entry (default: 2):

```typescript
mcpRegistry.register({
  id: 'web-search',
  name: 'Web Search',
  transport: { type: 'http', url: 'https://mcp.example.com/search' },
  maxRetries: 3, // Retry up to 3 times with backoff (1s, 2s, 4s)
});
```

**Per-tool execution timeouts**: Set `toolTimeoutMs` on the server entry to enforce a timeout on each individual tool call. This prevents hung tools from blocking the entire workflow:

```typescript
mcpRegistry.register({
  id: 'slow-api',
  name: 'External API',
  transport: { type: 'http', url: 'https://api.example.com/mcp' },
  toolTimeoutMs: 10_000, // 10 second timeout per tool call
});
```

You can also set a default timeout for all servers via `MCPConnectionManagerOptions`:

```typescript
const manager = new MCPConnectionManager(mcpRegistry, {
  default_tool_timeout_ms: 30_000, // 30s default for all servers
});
```

Server-level `toolTimeoutMs` overrides the default.

**Tool manifest caching**: Tool manifests from MCP servers are cached for 5 minutes by default, avoiding redundant `client.tools()` calls. Configure via `cache_ttl_ms`:

```typescript
const manager = new MCPConnectionManager(mcpRegistry, {
  cache_ttl_ms: 600_000, // 10 minute cache TTL
});
```

Set to `0` to disable caching.

**Manual reconnection**: Use `manager.reconnect(serverId)` to invalidate a stale connection and force a fresh reconnection on the next `resolveTools()` call.

## Taint tracking

All results returned from MCP tools are automatically taint-tracked. The raw tool result is returned directly to the LLM (no wrapper), while taint metadata is accumulated internally by the `MCPConnectionManager`. After agent execution completes, taint entries are drained via `drainTaintEntries()` and applied to any memory keys that received MCP tool results.

This design ensures:

- The **LLM sees clean results** — no taint metadata leaks into the model's context
- The **taint registry is accurate** — provenance is tracked in `memory._taint_registry`
- The **tool node executor** also correctly handles taint for `tool`-type nodes

See [Taint Tracking](/docs/concepts/taint-tracking/) for the full taint propagation model and API reference.

## Default MCP servers

cycgraph includes pre-configured entries for two common MCP reference servers. Use `registerDefaultMCPServers()` for one-line setup:

```typescript
import {
  InMemoryMCPServerRegistry,
  registerDefaultMCPServers,
  MCPConnectionManager,
} from '@cycgraph/orchestrator';

const mcpRegistry = new InMemoryMCPServerRegistry();
await registerDefaultMCPServers(mcpRegistry);
// Registers: web-search (Brave Search via npx) and fetch (URL content via uvx)
```

| Server ID | Package | Command | Requires |
|-----------|---------|---------|----------|
| `web-search` | `@modelcontextprotocol/server-brave-search` | `npx` | `BRAVE_API_KEY` env var |
| `fetch` | `mcp-server-fetch` (Python) | `uvx` | `uv` package manager |

Options for selective registration:

```typescript
// Only fetch (no web search)
await registerDefaultMCPServers(mcpRegistry, { only: ['fetch'] });

// Override the Brave API key
await registerDefaultMCPServers(mcpRegistry, { brave_api_key: 'BSA-...' });

// Restrict to specific agents
await registerDefaultMCPServers(mcpRegistry, { allowedAgents: [RESEARCHER_ID] });
```

## Next steps

- [Adding MCP Tools](/docs/guides/adding-tools/) — wiring tools into the execution pipeline and building custom MCP servers
- [Agents](/docs/concepts/agents/) — how agents use tools
- [Nodes](/docs/concepts/nodes/) — node-level tool overrides
- [Security](/docs/security/) — access control and taint tracking
