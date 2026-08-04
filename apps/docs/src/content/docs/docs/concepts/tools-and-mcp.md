---
title: Tools & MCP
description: How agents interact with external systems via tool sources and the Model Context Protocol.
---

Agents need tools to interact with the world. The orchestrator provides three tool layers behind one declaration format:

1. **Built-in tools**: Shipped with the engine. Pure and dependency-free, like `save_to_memory`.
2. **Custom tools**: Your own functions, defined with `defineTool()` and registered on the runner. The graph references them by name; the implementation is never serialized.
3. **MCP tools**: Provided by a registered MCP server via the **Model Context Protocol**. The graph references the server by ID; transport config and secrets stay in the trusted registry.

This decouples workflow definitions from implementations: graphs stay serializable, and the same graph runs anywhere the referenced tools are available.

## Declaring tools

Agents and nodes declare tools in a `tools` array. Authoring is lightweight — a bare name for anything that resolves locally, an `{ mcp }` ref for servers:

```typescript
import { InMemoryAgentRegistry } from '@cycgraph/orchestrator';

const agentRegistry = new InMemoryAgentRegistry();

const RESEARCH_AGENT = agentRegistry.register({
  name: 'Research Specialist',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You are a research specialist...',
  tools: [
    'save_to_memory',                              // built-in
    'lookup_order',                                // custom, registered on the runner
    { mcp: 'web-search', tools: ['search'] },      // MCP server ref with a tool filter
  ],
});
```

Whatever form you author, storage is always the structured wire union: a bare name becomes `{ type: 'builtin', name }` when it names a built-in and `{ type: 'custom', name }` otherwise, and `{ mcp: id, tools }` becomes `{ type: 'mcp', server_id, tool_names }`. The structured form is accepted directly wherever you prefer to be explicit. The `tools` filter on a server ref is worth the keystrokes: without it the agent receives every tool the server advertises, including ones a compromised server injects later.

### Node-level tool overrides

Graph nodes can override an agent's configured tools for a specific execution step. This lets you reuse the same general-purpose agent with different contextual tool sets throughout a graph.

```typescript
{
  id: 'initial-research',
  type: 'agent',
  agentId: RESEARCH_AGENT,
  tools: ['save_to_memory', { mcp: 'web-search' }, { mcp: 'twitter-search' }],
  readKeys: ['goal'],
  writeKeys: ['initial_notes'],
}
```

In this example, `save_to_memory` is included because the node may need to write structured data to multiple keys. For nodes that write to a single key, you can omit it, and the orchestrator captures text output automatically.

**Refs:**
- [ToolSource](#toolsource): Discriminated union of the three tool declaration shapes.
- [ToolSourceInput](#toolsourceinput): What authors may write — sugar or structured.
- [BuiltinToolSource](#builtintoolsource): A tool the orchestrator provides directly.
- [CustomToolSource](#customtoolsource): A host-registered tool, referenced by name.
- [MCPToolSource](#mcptoolsource): A tool provided by a registered MCP server, referenced by ID.

## Custom tools

`defineTool()` turns a function into a schema-validated tool. Register the result on `GraphRunnerOptions.tools`, and any agent or node can declare it by name:

```typescript
import { defineTool, GraphRunner } from '@cycgraph/orchestrator';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by ID from the host system',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.find(orderId),
});

const runner = new GraphRunner(graph, state, {
  tools: [lookupOrder, mcpManager],  // defined tools and MCP resolvers, one option
});
```

The `tools` option takes everything that provides tools: `defineTool()` results and `ToolResolver` implementations such as `MCPConnectionManager`, discriminated by shape. Resolution precedence is built-ins, then defined tools, then resolvers; a name collision between a local tool and an MCP tool keeps the local one and exposes the MCP tool under an `mcp__` prefix.

Three guarantees come with the wrapper:

- **Validated input**: the LLM's arguments are parsed through your Zod `parameters` schema on every call; invalid arguments surface to the model as a normal tool failure.
- **Timeout**: each call races a per-tool timeout (30s default, `timeoutMs` to change, `0` to disable), so a hung tool cannot stall the node.
- **Fail-at-start wiring**: a node declaring a custom tool that has no matching registration fails the runner's preflight check before any tokens are spent, exactly like MCP sources without a resolver.

By default custom tools are treated as first-party code and their output is not taint-tracked. Declare `taints: true` on tools that ingest external content — network fetches, user documents — and their results land in `state.taint_registry` with source `custom_tool`, feeding the same downstream taint gates as MCP output.

A curated set of pre-built tools ships as [`@cycgraph/tools`](/docs/guides/tool-library/): SSRF-guarded web access and pure data utilities, all `defineTool()` factories that register exactly like your own.

**Refs:**
- [`defineTool`](#definetool): The definition helper and its wrapper guarantees.
- [DefinedToolSpec](#definedtoolspec): The spec shape `defineTool` accepts.

## MCP Server Registry

The **trusted MCP Server Registry** holds transport configurations and connection secrets. This is the security boundary: agents reference servers by ID, but never see connection details.

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

Every entry is re-validated through `MCPServerEntrySchema` on **both** `saveServer` and `loadServer`, so the command allowlist and SSRF guard are enforced even against a direct DB write, a migration, or an `any`-typed caller, not just at compile time. http/sse URLs that resolve to private, loopback, link-local, or cloud-metadata addresses are rejected; set `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true` to allow them in local development.

Each entry also accepts optional resilience and access-control fields: `timeoutMs`, `toolTimeoutMs`, `maxConcurrentCalls`, `maxRetries`, and `allowedAgents`. See [`MCPServerConfig`](#mcpserverconfig) for the full field reference.

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

**Refs:**
- [`InMemoryMCPServerRegistry`](#inmemorymcpserverregistry): Zero-dependency registry for tests and single-process runs.
- [`MCPConnectionManager`](#mcpconnectionmanager): Resolves an agent's tool sources into executable tools.
- [`MCPServerEntrySchema`](#mcpserverentryschema): The validation boundary enforced on every read and write.
- [MCPServerConfig](#mcpserverconfig): Authoring shape for a registry entry.
- [MCPTransportConfig](#mcptransportconfig): The stdio, http, and sse transport shapes.
- [MCPServerRegistry](#mcpserverregistry): The registry contract both implementations satisfy.
- [MCPConnectionManagerOptions](#mcpconnectionmanageroptions): Cache, timeout, and concurrency tuning.

## Taint tracking

All results returned from MCP tools are automatically taint-tracked, and custom tools declared `taints: true` participate identically with source `custom_tool`. The raw tool result is returned directly to the LLM (no wrapper), while taint metadata is accumulated and tracked internally. After agent execution completes, taint entries are drained and applied to any memory keys that received external tool results.

This design ensures:

- The **LLM sees clean results**: no taint metadata leaks into the model's context.
- The **taint registry is accurate**: provenance is tracked in the first-class `state.taint_registry` field.
- The **tool node executor** also correctly handles taint for `tool`-type nodes.

See [Taint Tracking](/docs/concepts/taint-tracking/) for the full taint propagation model and API reference.

## API

### `defineTool`

Define a custom tool for registration on `GraphRunnerOptions.tools`. Validates the spec eagerly — an invalid name, a collision with a built-in name, or a missing description throws `ToolDefinitionError` at definition time, not mid-run. The returned tool's `execute` parses arguments through the Zod schema and enforces the per-call timeout.

```typescript
defineTool(spec: DefinedToolSpec): DefinedTool
```

The result carries the JSON-schema projection of your Zod `parameters` (what the LLM sees) alongside `name`, `description`, and `taints`. Duplicate names across the `tools` array throw at runner construction.

### `InMemoryMCPServerRegistry`

Zero-dependency [`MCPServerRegistry`](#mcpserverregistry) backed by a Map. Suitable for tests, single-process runs, and local development. Every write and read re-validates through [`MCPServerEntrySchema`](#mcpserverentryschema), so the stdio command allowlist and the URL SSRF guard hold even against a direct map tamper or an `any`-typed caller.

```typescript
new InMemoryMCPServerRegistry()
```

It accepts the camelCase [`MCPServerConfig`](#mcpserverconfig) authoring shape on write. Stored entries and `loadServer` results come back in the snake_case `MCPServerEntry` wire shape. `register(entry)` is a synchronous convenience alias for `saveServer`, handy in tests and setup code.

For production durability, use `DrizzleMCPServerRegistry` from `@cycgraph/orchestrator-postgres`. It implements the same interface against Postgres so server configs survive restarts.

### `MCPConnectionManager`

Resolves an agent's `ToolSource[]` into executable AI SDK tools. Create one per `GraphRunner.run()` invocation and call `closeAll()` when the run finishes. It implements the `ToolResolver` contract the runner injects.

```typescript
new MCPConnectionManager(registry: MCPServerRegistry, options?: MCPConnectionManagerOptions)
```

| Method | Description |
|--------|-------------|
| `resolveTools(sources, agentId?)` | Resolve `ToolSource[]` to a toolset. Enforces per-server `allowedAgents` access control, caches tool manifests, and applies per-tool timeouts. |
| `reconnect(serverId)` | Invalidate a stale connection and its cached manifest, forcing a fresh connection on the next `resolveTools`. |
| `closeAll()` | Close every open client. Call once the run completes. |

##### Options

The options are [`MCPConnectionManagerOptions`](#mcpconnectionmanageroptions).

### `MCPServerEntrySchema`

The Zod schema every server entry is validated against, on **both** `saveServer` and `loadServer`. This is the trust boundary. The stdio command allowlist (`npx`, `node`, `python3`, `python`, `uvx`) and the URL SSRF guard are enforced here, so a direct database write, a migration, or an `any`-typed caller can't slip past them. Parsing also fills defaults such as `timeoutMs` (30000) and `maxRetries` (2), and rejects stdio transports when `MCP_STDIO_DISABLED=true`.

```typescript
MCPServerEntrySchema.parse(entry): MCPServerEntry
```

## Interfaces

### ToolSource

Discriminated union on `type` of the three tool declaration shapes an agent or node lists in its `tools` array. This is the stored wire form; authoring usually goes through the lighter [ToolSourceInput](#toolsourceinput) sugar.

```typescript
type ToolSource = BuiltinToolSource | CustomToolSource | MCPToolSource
```

### ToolSourceInput

What authors may write wherever a tool source is expected. Every form normalizes to the structured [ToolSource](#toolsource) at the authoring boundary (`createGraph`, agent registration), so stored configs never carry the sugar.

| Form | Normalizes to |
|------|---------------|
| `'save_to_memory'` (a built-in name) | `{ type: 'builtin', name }` |
| `'lookup_order'` (any other name) | `{ type: 'custom', name }` |
| `{ mcp: 'web-search', tools: ['search'] }` | `{ type: 'mcp', server_id, tool_names }` |
| A structured `ToolSource` (either casing) | Passes through |

### DefinedToolSpec

The spec accepted by [`defineTool`](#definetool).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Referenced from graph/agent config. Alphanumeric, hyphens, underscores; must not collide with a built-in name. |
| `description` | `string` | required | Surfaced to the LLM. |
| `parameters` | `z.ZodType` | required | Argument schema, parsed on every call. |
| `execute` | `(args) => unknown` | required | The implementation. Receives parsed arguments. |
| `taints` | `boolean` | `false` | Taint-track results as external data (`custom_tool` source). |
| `timeoutMs` | `number` | `30000` | Per-call timeout. `0` disables. |

### BuiltinToolSource

A tool the orchestrator provides directly, with no external connection.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'builtin'` | Discriminant. |
| `name` | `'save_to_memory'` \| `'architect_draft_workflow'` \| `'architect_publish_workflow'` \| `'architect_get_workflow'` | Built-in tool name. |

### CustomToolSource

A host-registered custom tool, referenced by name. The implementation is a [`defineTool`](#definetool) result on `GraphRunnerOptions.tools`; an unmatched name fails the runner preflight.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'custom'` | Discriminant. |
| `name` | `string` | Registered tool name. Alphanumeric, hyphens, and underscores. |

### MCPToolSource

A tool provided by a registered MCP server, referenced by ID. It never contains transport config.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'mcp'` | required | Discriminant. |
| `serverId` | `string` | required | ID of a server in the MCP Server Registry. Alphanumeric, hyphens, and underscores. |
| `toolNames` | `string[]` | all tools | Filter to specific tools from the server. Omit for all of them. |

### MCPServerConfig

The camelCase authoring shape for a registry entry, accepted by `saveServer` and `register`. The stored and `loadServer`-returned form is the equivalent snake_case `MCPServerEntry`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | required | Unique server identifier, also used in tool namespacing. |
| `name` | `string` | required | Human-readable name. |
| `description` | `string` | — | What the server provides. |
| `transport` | [`MCPTransportConfig`](#mcptransportconfig) | required | Connection transport (stdio, http, or sse). |
| `allowedAgents` | `string[]` | unrestricted | Agent IDs permitted to use this server. Omit for open access. |
| `timeoutMs` | `number` | `30000` | Connection-level timeout. |
| `toolTimeoutMs` | `number` | — | Per-tool-call timeout, overrides the manager default. |
| `maxConcurrentCalls` | `number` | unlimited | Cap on concurrent tool calls against this server. |
| `maxRetries` | `number` | `2` | Connection retry attempts, with exponential backoff. |

### MCPTransportConfig

Discriminated union on `type` of the three transports. `stdio` runs a local process from a fixed command allowlist. `http` and `sse` reach remote servers over SSRF-guarded URLs.

| Transport | Fields |
|-----------|--------|
| `stdio` | `command` (`'npx'` \| `'node'` \| `'python3'` \| `'python'` \| `'uvx'`), `args: string[]`, `env?: Record<string, string>` |
| `http` | `url: string`, `headers?: Record<string, string>` |
| `sse` | `url: string`, `headers?: Record<string, string>` |

### MCPServerRegistry

The trusted store of transport configs and the security boundary between agent configs and connection secrets. Agents reference servers by ID and never see connection details. Both `InMemoryMCPServerRegistry` and `DrizzleMCPServerRegistry` implement it.

| Method | Description |
|--------|-------------|
| `saveServer(entry)` | Register or update a server from the camelCase [`MCPServerConfig`](#mcpserverconfig) shape. Re-validates through the schema. |
| `loadServer(id)` | Load a server by ID, or `null` if absent. Re-validates on read. |
| `listServers()` | List all registered servers. |
| `deleteServer(id)` | Remove a server by ID. Returns `true` if it existed. |

### MCPConnectionManagerOptions

Constructor options for [`MCPConnectionManager`](#mcpconnectionmanager). Every field is optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cache_ttl_ms` | `number` | `300000` | TTL for cached tool manifests. `0` disables caching. |
| `default_tool_timeout_ms` | `number` | `30000` | Default per-tool timeout, overridable per server via `toolTimeoutMs`. `0` disables it. |
| `default_max_concurrent_calls` | `number` | `0` | Default cap on concurrent calls per server. `0` means unlimited. |
| `tool_circuit_breaker` | `ToolCircuitBreakerOptions` \| `null` | 5 failures, 30s cooldown, 2 successes to close | Per-tool circuit breaker tuning. `null` disables per-tool breakers, leaving connection-level retry in place. |

## Next steps

- [Adding MCP Tools](/docs/guides/adding-tools/): wiring tools into the execution pipeline and building custom MCP servers
- [Agents](/docs/concepts/agents/): how agents use tools
- [Nodes](/docs/concepts/nodes/): node-level tool overrides
- [Security](/docs/security/): access control and taint tracking
