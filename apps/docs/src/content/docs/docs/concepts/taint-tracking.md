---
title: Taint Tracking
description: How cycgraph tracks external data provenance to prevent untrusted data from driving security-sensitive decisions.
---

Any data that enters a workflow from an external source (MCP tools, web searches, APIs) is automatically marked as **tainted**. Taint metadata records where the data came from, when it arrived, and whether downstream agents have processed it. This allows supervisors and security-sensitive nodes to distinguish trusted internal state from untrusted external inputs.

## How it works

Taint metadata is stored in a hidden registry at `memory._taint_registry`. This key is protected at two levels: the **agent executor** blocks agents from writing `_`-prefixed keys in `save_to_memory` calls, and the **state view** excludes `_`-prefixed keys from agent-visible memory. The executor itself injects `_taint_registry` as trusted system metadata after agent-level validation, and `validateAction()` in the GraphRunner skips `_`-prefixed keys during permission checks (since they are system-internal, not agent-authored).

When an MCP tool returns a result, the `MCPConnectionManager` accumulates taint metadata internally (keyed by `serverId:toolName`). After agent execution completes, the executor drains accumulated taint entries via `drainTaintEntries()` and calls `markTainted()` on any memory keys that received MCP tool results. The raw tool result is returned directly to the LLM — no taint wrapper is visible to the model. When an agent reads tainted inputs and produces outputs, `propagateDerivedTaint()` marks those outputs as `derived`-tainted.

## Taint sources

| Source | When it's applied |
|--------|------------------|
| `mcp_tool` | Result returned from an MCP server tool |
| `tool_node` | Result from a `tool`-type node execution |
| `agent_response` | Agent output when explicitly marked |
| `derived` | Agent output when any of its inputs were tainted |

## Taint metadata

Each tainted key has a `TaintMetadata` entry:

```typescript
interface TaintMetadata {
  source: 'mcp_tool' | 'tool_node' | 'agent_response' | 'derived';
  tool_name?: string;     // for tool sources
  server_id?: string;     // for MCP tool sources
  agent_id?: string;      // for agent/derived sources
  created_at: string;     // ISO 8601 timestamp
}
```

## API reference

All functions operate on the workflow `memory` object:

### `markTainted(memory, key, metadata)`

Mark a memory key as tainted with provenance metadata.

```typescript
import { markTainted } from '@cycgraph/orchestrator';

markTainted(state.memory, 'search_results', {
  source: 'mcp_tool',
  tool_name: 'search',
  server_id: 'web-search',
  created_at: new Date().toISOString(),
});
```

### `isTainted(memory, key)`

Check if a memory key is tainted.

```typescript
import { isTainted } from '@cycgraph/orchestrator';

if (isTainted(state.memory, 'search_results')) {
  // Do not use this data for routing decisions
}
```

### `getTaintInfo(memory, key)`

Get the full taint metadata for a specific key. Returns `undefined` if the key is not tainted.

```typescript
import { getTaintInfo } from '@cycgraph/orchestrator';

const info = getTaintInfo(state.memory, 'search_results');
if (info?.source === 'mcp_tool') {
  console.log(`Data from MCP server: ${info.server_id}`);
}
```

### `getTaintRegistry(memory)`

Get the full taint registry (all tainted keys and their metadata).

```typescript
import { getTaintRegistry } from '@cycgraph/orchestrator';

const registry = getTaintRegistry(state.memory);
// { search_results: { source: 'mcp_tool', ... }, summary: { source: 'derived', ... } }
```

### `propagateDerivedTaint(memory, outputKeys, agentId)`

Propagate taint from inputs to outputs. If any key in memory is tainted, all `outputKeys` are marked as `derived`-tainted. Returns the new taint entries (empty if no propagation occurred).

```typescript
import { propagateDerivedTaint } from '@cycgraph/orchestrator';

const newEntries = propagateDerivedTaint(state.memory, ['summary', 'draft'], 'writer-agent');
```

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
  strict_taint: true, // reject tainted data in routing
  nodes: [
    { id: 'fetch', type: 'tool', tool_id: 'web_search', read_keys: ['*'], write_keys: ['search_results'] },
    { id: 'analyze', type: 'agent', agent_id: ANALYST_ID, read_keys: ['search_results'], write_keys: ['analysis'] },
    { id: 'fallback', type: 'agent', agent_id: FALLBACK_ID, read_keys: ['goal'], write_keys: ['analysis'] },
  ],
  edges: [
    {
      source: 'fetch',
      target: 'analyze',
      condition: { type: 'conditional', condition: 'length(search_results) > 0' },
    },
    { source: 'fetch', target: 'fallback' }, // taken when strict_taint rejects the condition
  ],
  start_node: 'fetch',
  end_nodes: ['analyze', 'fallback'],
});
```

In this example, `search_results` is tainted (from an MCP tool). With `strict_taint: true`, the condition `search_results.length > 0` evaluates to `false` regardless of the actual value, and the workflow routes to `fallback`.

### Supervisor routing

When a supervisor node receives input containing tainted keys, the engine injects an explicit warning into the supervisor's prompt: the supervisor is told which keys are tainted and that routing decisions should not rely on their content. This gives the LLM the context to make safer routing choices, even without `strict_taint` enabled.

## Next steps

- [Tools & MCP](/docs/concepts/tools-and-mcp/) — how MCP tool results are automatically tainted
- [Security](/docs/security/) — access control and the zero-trust security model
- [Nodes](/docs/concepts/nodes/) — state slicing and the principle of least privilege
