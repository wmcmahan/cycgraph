---
"@cycgraph/orchestrator-postgres": minor
---

Implement the new optional memory interfaces from `@cycgraph/memory`:

- `DrizzleMemoryStore.touchFacts(ids, at?)` — single tenant-scoped `UPDATE` incrementing `access_count` (NULL-safe via `COALESCE`) and setting `last_accessed_at`; feeds consolidation's usage-aware decay scoring. No migration required — the columns already existed.
- `DrizzleOutcomeLedger.getFactStatsBatch(ids)` — one grouped `COUNT`/`AVG`/`var_samp` query replacing the per-candidate round-trip that gated lesson retrieval previously made on every prompt build. Verified against `InMemoryOutcomeLedger` in the parity suite.

The Drizzle memory store, index, and ledger follow `@cycgraph/memory`'s camelCase API conversion (filters, `SearchOptions`, `FactStats`, retention report/evidence); DB columns and stored JSON stay snake_case, mapped explicitly at the query boundary. `GateDecisionFilter.factId` and `FitnessTrendPoint` (`runId`, `recordedAt`) rename accordingly.

Also adds Postgres integration tests for `EntityResolver` against `DrizzleMemoryStore`, covering the `memory_entity_facts` join-table resync on fact remapping, edge rewriting, self-loop/duplicate dropping, and idempotency.
