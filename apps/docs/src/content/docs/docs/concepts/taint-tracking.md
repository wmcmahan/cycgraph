---
title: Taint Tracking
description: How cycgraph tracks external data provenance to prevent untrusted data from driving security-sensitive decisions.
---

Any data that enters a workflow from an external source (MCP tools, web searches, APIs) is automatically marked as **tainted**. Taint metadata records where the data came from, when it arrived, and whether downstream agents have processed it. This allows supervisors and security-sensitive nodes to distinguish trusted internal state from untrusted external inputs.

## How it works

Taint metadata lives in the first-class `state.taint_registry` field, structurally separate from the `memory` blackboard. That separation is the protection: the registry is never part of any node's state view, so agents cannot read or overwrite it through memory at all. Inside action payloads, new taint entries travel under the wire key `_taint_registry`. The reducers route that key to the state field and merge it **append-only**, so a crafted `update_memory: { _taint_registry: {} }` cannot clear or weaken taint. Any other `_`-prefixed key in a memory update is dropped fail-closed and recorded in `memory_drops` with reason `reserved_key`.

When an MCP tool returns a result, the `MCPConnectionManager` accumulates taint metadata in a **per-resolution collector** (one per `resolveTools()` call, keyed by `serverId:toolName`). After execution completes, the executor drains that specific collector via `drainTaintEntries(tools)` and calls `markTainted()` on any memory keys that received MCP tool results. The per-resolution collector means concurrent executions (voting, evolution, map) never cross-attribute taint. Both **agent** nodes and standalone **tool** nodes drain and apply taint, so external data is never written to memory untainted. The raw tool result is returned directly to the LLM, so no taint wrapper is visible to the model. When an agent reads tainted inputs and produces outputs, `propagateDerivedTaint()` marks those outputs as `derived`-tainted.

All of these helpers are pure. They take a `TaintRegistry` value and return a new one, never mutating in place, because state changes only happen through reducers.

**Refs:**
- [`markTainted`](#marktainted): Return a new registry with a key marked tainted.
- [`propagateDerivedTaint`](#propagatederivedtaint): Mark an agent's outputs `derived`-tainted when any input was tainted.
- [TaintRegistry](#taintregistry): Maps each tainted memory key to its provenance.

## Taint sources

| Source | When it's applied |
|--------|------------------|
| `mcp_tool` | Result returned from an MCP server tool |
| `tool_node` | Result from a `tool`-type node execution |
| `agent_response` | Agent output when explicitly marked |
| `derived` | Agent output when any of its inputs were tainted |
| `retrieval` | Fact injected into a prompt by memory retrieval |

**Refs:**
- [TaintMetadata](#taintmetadata): The provenance entry these sources populate.

## Taint propagation flow

```
MCP Tool "search"
  → memory.search_results  [tainted: mcp_tool, server_id: "web-search"]

Agent "researcher" reads search_results, writes summary
  → memory.summary          [tainted: derived, agent_id: "researcher"]

Agent "writer" reads summary, writes draft
  → memory.draft            [tainted: derived, agent_id: "writer"]
```

Once data is tainted, the taint follows it through every agent that processes it. This creates an auditable chain of provenance from the original external source through every transformation.

**Refs:**
- [`propagateDerivedTaint`](#propagatederivedtaint): The helper that extends the chain from inputs to outputs.

## Taint enforcement at decision points

Tainted data is tracked not only for auditing, but also enforced at routing decision points to prevent untrusted external data from controlling workflow control flow.

### Conditional edge routing

When a conditional edge expression references a tainted memory key, the engine logs a warning by default. This alerts operators that an external data source is influencing which path a workflow takes.

### Strict taint mode

Setting `strict_taint: true` on the graph upgrades warnings to hard rejections. When enabled, `evaluateCondition()` returns `false` for any condition that references a tainted key, forcing the workflow to take the fallback path instead of trusting external data:

```typescript
const graph = createGraph({
  name: 'Strict Taint Example',
  description: 'Routes to a fallback agent when external (tainted) data would otherwise drive the decision.',
  strictTaint: true, // reject tainted data in routing
  nodes: [
    { id: 'fetch', type: 'tool', toolId: 'web_search', readKeys: ['*'], writeKeys: ['search_results'] },
    { id: 'analyze', type: 'agent', agentId: ANALYST_ID, readKeys: ['search_results'], writeKeys: ['analysis'] },
    { id: 'fallback', type: 'agent', agentId: FALLBACK_ID, readKeys: ['goal'], writeKeys: ['analysis'] },
  ],
  edges: [
    {
      source: 'fetch',
      target: 'analyze',
      condition: { type: 'conditional', condition: 'length(search_results) > 0' },
    },
    { source: 'fetch', target: 'fallback' }, // taken when strict_taint rejects the condition
  ],
  startNode: 'fetch',
  endNodes: ['analyze', 'fallback'],
});
```

In this example, `search_results` is tainted (from an MCP tool). With `strict_taint: true`, the condition `search_results.length > 0` evaluates to `false` regardless of the actual value, and the workflow routes to `fallback`.

### Supervisor routing

When a supervisor node receives input containing tainted keys, the engine injects an explicit warning into the supervisor's prompt: the supervisor is told which keys are tainted and that routing decisions should not rely on their content. This gives the LLM the context to make safer routing choices, even without `strict_taint` enabled.

## API

All functions are pure. They read from or return a `TaintRegistry` value and never mutate their input, because state changes happen through reducers.

### `getTaintRegistry`

Read the taint registry from workflow state. Returns an empty registry when the field is absent, such as a hand-built state that skipped schema defaults.

```typescript
import { getTaintRegistry } from '@cycgraph/orchestrator';

function getTaintRegistry(
  state: Pick<WorkflowState, 'taint_registry'>,
): TaintRegistry;

const registry = getTaintRegistry(state);
// { search_results: { source: 'mcp_tool', ... }, summary: { source: 'derived', ... } }
```

### `markTainted`

Return a new registry with `key` marked tainted using the provided provenance metadata. The input registry is not mutated.

```typescript
import { markTainted } from '@cycgraph/orchestrator';

function markTainted(
  registry: TaintRegistry,
  key: string,
  meta: TaintMetadata,
): TaintRegistry;

const next = markTainted(getTaintRegistry(state), 'search_results', {
  source: 'mcp_tool',
  tool_name: 'search',
  server_id: 'web-search',
  created_at: new Date().toISOString(),
});
```

### `isTainted`

Check whether a key has an entry in the taint registry. Uses `Object.hasOwn`, so a key named `constructor` or `toString` does not read as tainted through the prototype chain.

```typescript
import { isTainted } from '@cycgraph/orchestrator';

function isTainted(registry: TaintRegistry, key: string): boolean;

if (isTainted(getTaintRegistry(state), 'search_results')) {
  // Do not use this data for routing decisions
}
```

### `getTaintInfo`

Get the full taint metadata for a specific key. Returns `undefined` if the key is not tainted.

```typescript
import { getTaintInfo } from '@cycgraph/orchestrator';

function getTaintInfo(
  registry: TaintRegistry,
  key: string,
): TaintMetadata | undefined;

const info = getTaintInfo(getTaintRegistry(state), 'search_results');
if (info?.source === 'mcp_tool') {
  console.log(`Data from MCP server: ${info.server_id}`);
}
```

### `propagateDerivedTaint`

Propagate taint from an agent's readable inputs to its outputs. If any key in `readableMemory` is tainted in `registry`, every entry in `outputKeys` is marked `derived`-tainted. Returns only the new entries, empty when no propagation occurred.

```typescript
import { propagateDerivedTaint } from '@cycgraph/orchestrator';

function propagateDerivedTaint(
  readableMemory: Record<string, unknown>,
  registry: TaintRegistry,
  outputKeys: string[],
  agentId: string,
): TaintRegistry;

const newEntries = propagateDerivedTaint(
  readableMemory,
  getTaintRegistry(state),
  ['summary', 'draft'],
  'writer-agent',
);
```

##### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `readableMemory` | `Record<string, unknown>` | The memory slice the agent could read, its state view. |
| `registry` | `TaintRegistry` | Taint registry scoped to those readable keys. |
| `outputKeys` | `string[]` | Memory keys written by the agent. |
| `agentId` | `string` | ID of the agent that produced the outputs. |

## Interfaces

### TaintMetadata

Provenance of the untrusted data behind one memory key. Keyed by memory key inside [`TaintRegistry`](#taintregistry). Defined by `TaintMetadataSchema` so the type and the runtime schema cannot drift. This is the same shape documented on [Workflow State](/docs/concepts/workflow-state/#taintmetadata).

| Field | Type | Description |
|-------|------|-------------|
| `source` | `'mcp_tool'` \| `'tool_node'` \| `'agent_response'` \| `'derived'` \| `'retrieval'` | Origin of the data. |
| `tool_name` | `string?` | Tool that produced the data, for tool sources. |
| `server_id` | `string?` | MCP server that provided the tool, for `'mcp_tool'`. |
| `agent_id` | `string?` | Agent that produced the data, for `'agent_response'` or `'derived'`. |
| `created_at` | `string` | ISO 8601 timestamp. |

### TaintRegistry

Maps each tainted memory key to its `TaintMetadata` provenance. Stored on the first-class `state.taint_registry` field and merged append-only by the reducers.

```typescript
type TaintRegistry = Record<string, TaintMetadata>;
```

## Next steps

- [Tools & MCP](/docs/concepts/tools-and-mcp/): how MCP tool results are automatically tainted
- [Workflow State](/docs/concepts/workflow-state/): the state fields taint lives alongside
- [Security](/docs/security/): access control and the zero-trust security model
- [Nodes](/docs/concepts/nodes/): state slicing and the principle of least privilege
