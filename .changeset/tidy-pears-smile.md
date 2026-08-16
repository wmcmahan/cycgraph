---
"@cycgraph/orchestrator": patch
---

`validateGraph` now warns when `read_keys` lists `goal` or `constraints`.

Both are first-class state fields, set on every state view regardless of grants — a node with `reads: []` already receives them. Listing them reads as a permission that was needed and teaches the wrong model of what `read_keys` controls, which is *additional memory* the node may see.

The warning is suppressed when a node genuinely writes a memory key of that name, since a memory key named `goal` is distinct from `state.goal` and reading it is a real grant.

The shipped examples listed one or both in 39 places, contradicting the `reads` documentation. They no longer do.
