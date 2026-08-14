---
title: Custom Tools
description: Define your own tools with tool() and register them on the runner.
---

MCP is the right tool layer for third-party integrations, but it's heavy machinery for a ten-line function you already have in your codebase. The custom tool layer covers that case: define a tool with `tool()` (part of the authoring vocabulary; `defineTool` is the same function under its verbose name) and reference the value from any agent or node — `run()` wires the implementation onto the runner for you. The graph stays serializable because it only ever carries the tool's name; the reference collapses at compile time.

## Define

```typescript
import { tool, runTool } from '@cycgraph/orchestrator';
import { z } from 'zod';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Fetch an order by ID from the host system',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.find(orderId),
});
```

`parameters` is a Zod schema doing double duty: its JSON-schema projection is what the LLM sees, and every call's arguments are parsed through it before your `execute` runs. Invalid arguments never reach your code; they surface to the model as a normal tool failure it can correct.

Validation is eager. A bad name, a collision with a built-in tool name, or a missing description throws `ToolDefinitionError` at definition time.

## Reference

In a facade workflow, referencing the value is the whole setup:

```typescript
import { agent, node, graph, run } from '@cycgraph/orchestrator';

const support = node({
  id: 'support',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'Handle the support request.',
    tools: [lookupOrder],          // by reference — nothing else to wire
  }),
  reads: ['goal'],
  writes: 'reply',
});

await run(graph({ name: 'support', nodes: [support], edges: [] }), { goal: '...' });
```

`graph()` collapses the reference to `{ type: 'custom', name: 'lookup_order' }` in the wire graph and `run()` registers the implementation on the runner, exactly how inline `agent()` values are collected and registered. One tool value referenced from several agents or nodes registers once; two distinct tools sharing a name fail at compile time.

## Register (raw API and serialized graphs)

A tool referenced by *name* — from a raw `createGraph` workflow, or a graph that was serialized and reloaded, where the implementation can't travel with it — is registered on the runner explicitly:

```typescript
const runner = new GraphRunner(graph, state, {
  tools: [lookupOrder, submitTicket, mcpManager],
});
```

The `tools` option takes everything that provides tools in one array: `tool()` results and `ToolResolver` implementations like `MCPConnectionManager`, discriminated by shape. Duplicate custom names throw at construction. MCP resolvers always go here, facade or not — a connection manager is per-run infrastructure, not part of a graph.

## Declare by name

Where the value isn't in scope, agents and nodes reference the tool by bare name:

```typescript
const support = agent({
  name: 'Support Agent',
  model: 'claude-sonnet-4-6',
  instructions: '...',
  tools: ['lookup_order'],
});
```

A name that matches a built-in resolves as a built-in; anything else resolves against your registrations. Note there's no `save_to_memory` here: the orchestrator captures the agent's text output and routes it to the node's write key automatically, so the built-in is only worth declaring when an agent must write structured data to multiple keys in one execution. If a node declares a custom tool with no matching registration, the run fails the preflight wiring check before any node executes, with a message naming the node and the tool.

Custom tools also work in standalone `tool` nodes:

```typescript
runTool('lookup_order', {
  id: 'fetch-order',
  reads: ['goal'],
})
```

The result lands in `memory.fetch_order_result`.

## External data: declare taint

Custom tools default to untainted output because they are your own code. When a tool ingests external content — a network fetch, a user-uploaded document — declare it:

```typescript
const fetchPage = tool({
  name: 'fetch_page',
  description: 'Fetch a web page as text',
  parameters: z.object({ url: z.string().url() }),
  execute: async ({ url }) => (await fetch(url)).text(),
  taints: true,
});
```

Results from a `taints: true` tool are recorded in `state.taint_registry` with source `custom_tool`, on the error path too, and feed the same downstream taint gates as MCP output. See [Taint Tracking](/docs/concepts/taint-tracking/).

## Timeouts and failures

Each call races a per-tool timeout, 30 seconds by default. Tune it per tool with `timeoutMs`, or pass `0` to disable. A thrown error (your code, validation, or the timeout) becomes a tool-call failure the LLM sees and can react to; it does not kill the node.

## Testing

A defined tool is just an object; call its wrapped `execute` directly in unit tests to cover validation and behavior:

```typescript
await expect(lookupOrder.execute({ orderId: 'o-1' })).resolves.toEqual(order);
await expect(lookupOrder.execute({ orderId: 42 })).rejects.toThrow();
```

For workflow-level tests, register the tool on a `GraphRunner` with a `tool` node — no LLM or network required.

## Related

- [Tools & MCP](/docs/concepts/tools-and-mcp/): the three tool layers and the wire format
- [Adding MCP Tools](/docs/guides/adding-tools/): the MCP path for out-of-process integrations
- [Taint Tracking](/docs/concepts/taint-tracking/): how external data is tracked through state
