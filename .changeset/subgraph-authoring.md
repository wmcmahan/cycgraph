---
"@cycgraph/orchestrator": minor
---

Add `subgraph()` to the authoring facade: compose a child graph into a parent topology as a first-class value.

```ts
const parent = graph({
  name: 'parent',
  nodes: [
    subgraph(child, {
      id: 'call-child',
      reads: ['topic'],
      writes: 'result',
      inputs:  { topic: 'goal_in' },  // parent key → child key
      outputs: { out: 'result' },     // child key → parent key
    }),
  ],
});

await run(parent, { goal: '...' });   // no hand-wired loadGraph
```

When the child is a `graph()` value in scope, `run()` resolves it automatically and registers its agents and inline tools transitively, including grandchildren. A caller-supplied `loadGraph` still wins for ids it resolves, which is the seam for pre-registered and third-party graphs. `subgraph()` compiles to the identical `subgraph_config` wire the raw API produces, so serialization, persistence, and the durable runner are unchanged. Also exports `graphsForGraph()` alongside `agentsForGraph()`/`toolsForGraph()`.
