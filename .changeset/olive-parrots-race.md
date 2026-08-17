---
"@cycgraph/orchestrator": patch
---

`subgraph` and `a2a` keep their output mapping, so a reader can name a parent key without retyping it.

Both helpers fold `outputs` into the node's config, so the mapping was gone from the authored value by the time a downstream node wanted it — and the parent-side name, a local rename with no other definition site, had to be retyped.

```ts
const research = subgraph(child, { id: 'research', outputs: { notes: 'findings' } });
node({ id: 'write', reads: [research.outputs.notes] });   // 'findings'
```

Reaching through the *child's* name rather than the parent's is deliberate: the child-side key is the delegate's declared output and stable across callers, where the parent-side name exists only in this mapping. Renaming the parent key now updates every reader.

`outputs` is non-enumerable, so it does not travel back onto the wire node; the mapping still lands in `subgraph_config.output_mapping` as before. It is `{}` rather than absent when a node maps nothing out.
