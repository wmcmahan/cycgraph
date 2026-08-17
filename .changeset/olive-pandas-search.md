---
"@cycgraph/orchestrator": patch
---

An authored node carries the memory keys it writes, so readers name them instead of retyping the convention.

A node's outputs are derived from its id: a map node writes `${id}_results`, a tool node `${id}_result`, singular. Getting one wrong is a silent failure — the reader receives an empty slice, produces something plausible from nothing, and passes any assertion that only checks the key exists.

```ts
const fan = mapReduce(worker, { id: 'fan', into: 'reduce' });
node({ id: 'reduce', type: 'synthesizer', reads: [fan.results] });
```

`mapReduce`, `voting`, `evolution`, `reflection`, and `node()` for tool, synthesizer, and agent types now return values carrying their own keys. A typo is a compile error and renaming a node updates its readers.

The properties are non-enumerable, so `graph()` — which builds the wire node by spreading the authored value — never sees them. Nothing reaches the schema or a serialized graph. They mirror `impliedResultKeys`, which stays the runtime authority for what a node may write, and the two are checked against each other in the test suite.

A node's declared `writes` is kept at its literal type too, so a downstream `reads: [draft.writes]` is checked rather than retyped. The two differ in strength and the JSDoc says so: an output key is written by executor machinery and is there whenever the node succeeds, while `writes` is a grant — the agent may write that key, write nothing, or have its text routed to `${id}_output` when no write key claims it.

The shipped examples use the new form. Note the declaration order it forces: a reducer needs the fan-out's key and the fan-out needs the reducer, so declare the fan-out first and pass `into` the synthesizer's id as a string.
