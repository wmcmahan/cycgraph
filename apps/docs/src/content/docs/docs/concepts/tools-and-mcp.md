---
title: Tools & MCP
description: How agents interact with external systems via tool sources and the Model Context Protocol.
---

Agents need tools to interact with the world. The orchestrator provides three tool layers behind one declaration format:

1. **Built-in tools**: Shipped with the engine. Pure and dependency-free.
2. **Custom tools**: Your own functions, defined with `tool` and registered on the run. The graph references them by name; the implementation is never serialized.
3. **MCP tools**: Provided by a registered MCP server via the **Model Context Protocol**. The graph references the server by ID; transport config and secrets stay in the trusted registry.

This decouples workflow definitions from implementations: graphs stay serializable, and the same graph runs anywhere the referenced tools are available.

## Declaring tools

```typescript
import { agent, tool } from '@cycgraph/orchestrator';
import { z } from 'zod';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Fetch an order by ID from the host system',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.find(orderId),
});

const researchAgent = agent({
  model: 'claude-sonnet-4-6',
  instructions: 'You are a research specialist...',
  tools: [
    lookupOrder,
    { mcp: 'web-search', tools: ['search'] },
  ],
});
```

### Node-level tool overrides

Graph nodes can override an agent's configured tools for a specific execution step. This lets you reuse the same general-purpose agent with different contextual tool sets throughout a graph.

```typescript
const initialResearch = node({
  id: 'initial-research',
  agent: researchAgent,
  tools: [
    { mcp: 'web-search' },
    { mcp: 'twitter-search' }
  ],
  writes: 'initial_notes',
});
```

**Refs:**
- [ToolSource](#toolsource): Discriminated union of the three tool declaration shapes.
- [ToolSourceInput](#toolsourceinput): What authors may write — sugar or structured.
- [BuiltinToolSource](#builtintoolsource): A tool the orchestrator provides directly.
- [CustomToolSource](#customtoolsource): A host-registered tool, referenced by name.
- [MCPToolSource](#mcptoolsource): A tool provided by a registered MCP server, referenced by ID.

## Custom tools

`tool` turns a function into a schema-validated tool. Referencing the value from an agent or node `tools` array, as in the example above, is all a facade workflow needs. The run registers the implementation automatically.

The `tools` option on the run is where implementations land, and you use it directly in two cases: MCP resolvers (an `MCPConnectionManager` is per-run infrastructure, not part of a graph), and any tool a graph references by *name* rather than by value — a serialized graph, or a raw-API workflow:

```typescript
await run(workflow, { goal: 'Look up order 1234' }, {
  runner: { tools: [mcpManager] },
});
```

On the raw API the same option sits directly on the runner: `new GraphRunner(graph, state, { tools: [lookupOrder, mcpManager] })`. Passing a tool there that a facade graph also references inline is a no-op, not a duplicate.

The `tools` option takes everything that provides tools: `tool()` results and `ToolResolver` implementations such as `MCPConnectionManager`, discriminated by shape. Resolution precedence is built-ins, then defined tools, then resolvers.

Three guarantees come with the wrapper:

- **Validated input**: the LLM's arguments are parsed through your `parameters` schema on every call; invalid arguments surface to the model as a normal tool failure.
- **Timeout**: each call races a per-tool timeout (30s default, `timeoutMs` to change, `0` to disable), so a hung tool cannot stall the node.
- **Fail-at-start wiring**: a node declaring a custom tool that has no matching registration fails the runner's preflight check before any tokens are spent, exactly like MCP sources without a resolver.

By default custom tools are treated as first-party code and their output is not taint-tracked. Declare `taints: true` on tools that ingest external content, network fetches, user documents and their results land in the taint registry with a source  of `custom_tool`, feeding the same downstream taint gates as MCP output.

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

For production environments, use `DrizzleMCPServerRegistry` from `@cycgraph/orchestrator-postgres` to store server configurations durably in the database.

To skip the manual wiring, `registerDefaultMCPServers(registry)` registers a set of common stdio servers (web fetch and search) in one call:

```typescript
import { registerDefaultMCPServers } from '@cycgraph/orchestrator';

const registered = await registerDefaultMCPServers(mcpRegistry);
```

### Wiring MCP into a run

An `MCPConnectionManager` resolves the registered servers at execution time. Create one, pass it through the same `tools` option that carries custom tools, and close it when the run finishes:

```typescript
import { MCPConnectionManager, run } from '@cycgraph/orchestrator';

const mcpManager = new MCPConnectionManager(mcpRegistry);
try {
  await run(workflow, { goal: '...' }, { runner: { tools: [mcpManager] } });
} finally {
  await mcpManager.closeAll();
}
```

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
  maxRetries: 3,
});
```

**Per-tool execution timeouts**: Set `toolTimeoutMs` on the server entry to enforce a timeout on each individual tool call. This prevents hung tools from blocking the entire workflow:

```typescript
mcpRegistry.register({
  id: 'slow-api',
  name: 'External API',
  transport: { type: 'http', url: 'https://api.example.com/mcp' },
  toolTimeoutMs: 10_000,
});
```

You can also set a default timeout for all servers via `MCPConnectionManagerOptions`:

```typescript
const manager = new MCPConnectionManager(mcpRegistry, {
  default_tool_timeout_ms: 30_000,
});
```

Server-level `toolTimeoutMs` overrides the default.

**Tool manifest caching**: Tool manifests from MCP servers are cached for 5 minutes by default, avoiding redundant `client.tools()` calls. Configure via `cache_ttl_ms`:

```typescript
const manager = new MCPConnectionManager(mcpRegistry, {
  cache_ttl_ms: 600_000,
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

Define a custom tool for registration on the `tools` option. `tool` is the terse alias in the authoring vocabulary and the same function under a shorter name. Validates the spec eagerly. An invalid name, a collision with a built-in name, or a missing description throws `ToolDefinitionError` at definition time, not mid-run. The returned tool's `execute` parses arguments through the Zod schema and enforces the per-call timeout.

```typescript
tool(spec: DefinedToolSpec): DefinedTool
defineTool(spec: DefinedToolSpec): DefinedTool
```

The result carries the JSON-schema projection of your Zod `parameters` (what the LLM sees) alongside `name`, `description`, and `taints`. Duplicate names across the `tools` array throw at runner construction.

### `InMemoryMCPServerRegistry`

Zero-dependency [`MCPServerRegistry`](#mcpserverregistry) backed by a Map. Suitable for tests, single-process runs, and local development. Every write and read re-validates through [`MCPServerEntrySchema`](#mcpserverentryschema), so the stdio command allowlist and the URL SSRF guard hold even against a direct map tamper or an `any`-typed caller.

```typescript
new InMemoryMCPServerRegistry()
```

It accepts the [`MCPServerConfig`](#mcpserverconfig) authoring shape on write. Stored entries and `loadServer` results come back in the `MCPServerEntry` wire shape. `register(entry)` is a synchronous convenience alias for `saveServer`, handy in tests and setup code.

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
| A `tool()` / `defineTool()` value | `{ type: 'custom', name }` — the implementation is stashed for `run()` in facade graphs, never serialized |
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

The authoring shape for a registry entry, accepted by `saveServer` and `register`. The stored and `loadServer`-returned form is the equivalent `MCPServerEntry`.

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
| `saveServer(entry)` | Register or update a server from the [`MCPServerConfig`](#mcpserverconfig) shape. Re-validates through the schema. |
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
