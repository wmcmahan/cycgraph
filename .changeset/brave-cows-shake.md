---
"@cycgraph/orchestrator": minor
---

`memoryKeys` declares a graph's memory keys once, so they stop being retyped.

A key several nodes share has no owning node to name it. In a repair loop two nodes write the same key and a third reads it, so the `writes`-on-one-node pattern cannot help. Without a declaration the name is repeated at every use: node grants, verifier targets, edge conditions, the seeded state, the readback, and — most fragile of all — inside prompt text, where a rename leaves the agent's instructions describing a key that no longer exists while everything still compiles.

```ts
const mem = memoryKeys({
  email_text: { seeded: true, schema: { type: 'string' } },
  purchase_order: { schema: { type: 'object' } },
});

node({ reads: [mem.email_text], writes: mem.purchase_order });
graph({ nodes, inputs: mem.inputs });
state({ workflowId: g.id, goal, memory: mem.seed({ email_text: body }) });
```

Each property's type is the key's own literal name, so a misspelling does not compile. `mem.inputs` derives the graph's declared inputs from the seeded keys, which is what `strictKeys` needs to tell a seeded value from a typo. `mem.seed` refuses an undeclared key, a key a node writes rather than the caller seeding, and a required key left out.

`inputs` and `seed` are reserved names; declaring a key called either throws `GraphSpecError`.

The `verifier-fix-loop` example uses it. Renaming a key there moves all eleven use sites, prompts included.
