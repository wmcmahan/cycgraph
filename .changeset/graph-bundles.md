---
"@cycgraph/orchestrator": minor
---

Graph bundles: package a composition as a portable artifact and drop it into another graph.

`bundle(g, { version })` assembles a `GraphBundle` from a facade-authored composition: a manifest carrying the graph's declared interface and its computed host requirements (`requires`: custom tools with argument schemas, MCP servers, models), plus everything that travels — the entry graph, the transitive child-graph closure, and the agent definitions in wire form. `JSON.stringify(bundle)` is the complete distribution artifact. Implementations never travel: inline `tool()` code stays behind and appears in `requires.tools` for the host to supply by name.

`parseBundle(data)` validates a bundle arriving from an untrusted source (a file, an npm package), and `subgraph()` now accepts a bundle directly:

```ts
import researchBundle from '@acme/research-graph'; // default-exports a GraphBundle

const pipeline = graph({
  nodes: [
    subgraph(parseBundle(researchBundle), {
      id: 'research',
      inputs:  { topic: 'goal_in' },
      outputs: { out: 'findings' },
      writes: 'findings',
    }),
  ],
});

await run(pipeline, { goal: '...' });
```

Mappings are validated against the bundle's declared interface at compile time, values crossing the boundary are schema-checked at runtime, and `run()` registers the bundle's agents and resolves its child graphs automatically. New exports: `bundle`, `parseBundle`, `isGraphBundle`, the `GraphBundleSchema` / `GraphManifestSchema` wire schemas, and their types.
