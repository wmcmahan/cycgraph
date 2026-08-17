---
"@cycgraph/orchestrator": minor
---

An approval node's `review_keys` now imply read grants, so a reviewer is shown what the gate said they would be shown.

The approval executor builds its review payload out of the node's sliced state view, which is filtered by `read_keys`. A key named in `review_keys` but absent from `read_keys` was therefore dropped — silently, leaving the reviewer an empty panel and nothing explaining why. A gate configured `reviewKeys: [draft.result]` showed nothing at all unless the same key was also declared as a read.

Declaring that a node displays a key is the same statement as declaring it reads one, so `effectiveReadKeys` unions them. This matches how the codebase already derives permissions: a supervisor's `managed_nodes` imply its reads, and a tool node's result key is implied by its type.

A wildcard is deliberately **not** widened. `['*']` is the default for `review_keys` and means "everything this node can see", not "escalate this node to everything" — reading it the other way would hand full memory to every approval gate nobody had configured. Only explicitly named keys widen.
