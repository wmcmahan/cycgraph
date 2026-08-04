---
title: Custom Tools
description: Define your own tools with defineTool and register them on the runner.
---

MCP is the right tool layer for third-party integrations, but it's heavy machinery for a ten-line function you already have in your codebase. The custom tool layer covers that case: define a tool with `defineTool()`, register it on the runner, and reference it by name from any agent or node. The graph stays serializable because it only ever carries the name.

## Define

```typescript
import { defineTool } from '@cycgraph/orchestrator';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by ID from the host system',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.find(orderId),
});
```

`parameters` is a Zod schema doing double duty: its JSON-schema projection is what the LLM sees, and every call's arguments are parsed through it before your `execute` runs. Invalid arguments never reach your code; they surface to the model as a normal tool failure it can correct.

Validation is eager. A bad name, a collision with a built-in tool name, or a missing description throws `ToolDefinitionError` at definition time.

## Register

```typescript
const runner = new GraphRunner(graph, state, {
  tools: [lookupOrder, submitTicket, mcpManager],
});
```

The `tools` option takes everything that provides tools in one array: `defineTool()` results and `ToolResolver` implementations like `MCPConnectionManager`, discriminated by shape. Duplicate custom names throw at construction.

## Declare

Agents and nodes reference the tool by bare name:

```typescript
const AGENT = agentRegistry.register({
  name: 'Support Agent',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: '...',
  tools: ['lookup_order'],
});
```

A name that matches a built-in resolves as a built-in; anything else resolves against your registrations. Note there's no `save_to_memory` here: the orchestrator captures the agent's text output and routes it to the node's write key automatically, so the built-in is only worth declaring when an agent must write structured data to multiple keys in one execution. If a node declares a custom tool with no matching registration, the run fails the preflight wiring check before any node executes, with a message naming the node and the tool.

Custom tools also work in standalone `tool` nodes:

```typescript
{
  id: 'fetch-order',
  type: 'tool',
  toolId: 'lookup_order',
  tools: ['lookup_order'],
  readKeys: ['goal'],
}
```

The result lands in `memory.fetch_order_result`.

## External data: declare taint

Custom tools default to untainted output because they are your own code. When a tool ingests external content — a network fetch, a user-uploaded document — declare it:

```typescript
const fetchPage = defineTool({
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
