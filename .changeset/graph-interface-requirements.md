---
"@cycgraph/orchestrator": minor
---

Graphs can declare a public interface, and compositions can compute their host requirements.

`graph()` accepts optional `inputs` / `outputs` declaring the memory keys a graph expects seeded and produces, authored as Zod schemas (or raw JSON Schema) and serialized as JSON Schema on the wire:

```ts
const research = graph({
  name: 'research-block',
  nodes: [/* … */],
  inputs:  { topic: z.string() },
  outputs: { summary: z.string() },
});
```

The declaration makes the subgraph boundary a typed call. At compile time, `subgraph()` mappings are validated against the child's declared interface: mapping an undeclared key, or leaving a required input unmapped, is a hard `GraphSpecError`. At runtime, values crossing the boundary are validated against the schemas in both directions and a violation fails the node with the new `SubgraphInterfaceError` — including for children resolved by id that never saw the compile-time check. Graphs without a declared interface behave exactly as before.

Also adds `computeRequirements(graph)`: walks a composition's `subgraph()` closure and returns the host dependency contract — custom tools (with argument schemas and taint flags when implementations are in scope), MCP server ids, and models. This is the generated half of the upcoming bundle manifest's `requires` block.
