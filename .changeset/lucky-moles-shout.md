---
"@cycgraph/orchestrator": minor
---

Dangling-read validation now counts a graph's declared `inputs`, and a new `memory_not_empty` assertion distinguishes a key that exists from one that carries something.

`validateGraph` warned that a `read_keys` entry was "not produced by any node in this graph" even when the graph declared that key as an input. A declared input is supplied by whoever runs the graph, so reading one is the contract being honoured rather than a probable typo. Declaring `inputs` is now also the way to tell the validator about keys seeded into initial workflow memory, which it cannot otherwise see.

`memory_contains` is satisfied by a key holding `[]`, `''`, `{}`, or `null`, so a step that ran and produced nothing passes it. `memory_not_empty` asserts that work was actually done, while still passing on legitimate falsy values like `0` and `false`.
