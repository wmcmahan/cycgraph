---
"@cycgraph/orchestrator": patch
---

`applyChanges(graph, registry, changes)`: permanent application of the replay
change vocabulary. The counterpart of the fork overlay for changes that have
earned their place — agents patch in place under their own ids, node configs
patch through schema and graph validation, and the durable subset (`model`,
`prompt`, `temperature`, `config`) is enforced by kind: the run-scoped kinds
(`output`, `tool`, `memory`, `route`, `human_response`) are rejected rather
than half-applied. Returns the patched graph and the changed registry entries
for the caller to persist.
