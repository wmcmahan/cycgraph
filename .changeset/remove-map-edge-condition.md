---
"@cycgraph/orchestrator": minor
---

Remove the vestigial `map` edge-condition type. Map-reduce fan-out was never edge-driven: a `map` node names its worker in `map_reduce_config.worker_node_id` and invokes it directly, the worker needs no inbound edge, and the validator already treats config-referenced workers as reachable. A `map` edge merely evaluated like `always` (or like `conditional` when given an expression), so the type was a misleading synonym with no behavior of its own.

`EdgeConditionSchema.type` is now `'always' | 'conditional'`. The condition evaluator, graph validator, and architect schema no longer accept `map`.

**Migration:** replace `condition: { type: 'map' }` with `{ type: 'always' }` (or simply omit `condition` — `always` is the default), and `{ type: 'map', condition: expr }` with `{ type: 'conditional', condition: expr }`. Behavior is identical. A persisted graph carrying a `map` edge now fails schema validation on load with a clear error naming the edge, rather than routing under an alias.
