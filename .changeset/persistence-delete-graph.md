---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
---

Add `deleteGraph(graph_id): Promise<boolean>` to the persistence port. Removes a graph definition (tenant-scoped) and returns `true` when a row existed, `false` when it didn't — so callers can distinguish a delete from a no-op. Implemented on both the in-memory provider and `DrizzlePersistenceProvider` (a tenant-scoped `DELETE ... RETURNING`). Additive to the `PersistenceProvider` interface.
