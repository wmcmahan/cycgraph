---
"@cycgraph/orchestrator-postgres": minor
---

Multi-tenant isolation, fencing, and retention fixes.

- **Cross-tenant upsert guard.** Every tenant-scoped `onConflictDoUpdate` (graphs, workflow runs, MCP servers, the memory tables, run outcomes) now scopes the UPDATE to the caller's tenant (`setWhere`). Previously a caller-supplied primary-key collision could overwrite another tenant's row — e.g. `saveServer({ id: "github", … })` clobbering another tenant's MCP transport (the command the engine later spawns).
- **Queue runs on the platform plane.** `DrizzleWorkflowQueue` methods now run through `withPlatform` (the BYPASSRLS connection) instead of the tenant-subject connection. Once RLS is enforced (`FORCE`, migration 0019) with a non-superuser owner, the previous owner-connection `dequeue` would have returned zero rows and silently stopped delivering jobs.
- **`compact()` is fenced.** Event-log compaction now verifies the run's claim epoch before deleting, so a reclaimed/stale worker can't delete events belonging to the run a new claimant owns (which would corrupt the new claimant's replay). Throws `StaleClaimError`, matching `append`.
- **Retention actually reclaims storage.** `deleteWarmData` now deletes cold (archived) runs, cascading via FK to their `workflow_states`, `workflow_events` (the highest-volume table), `workflow_checkpoints`, and `usage_records` — previously only `workflow_states` rows were deleted, so events/usage grew forever. The archive sweep is batched to bound its transaction, and `getStorageStats().cold_runs` reports a real count instead of a hardcoded `0`.
- **`findFacts` gains `exclude_tags`** (SQL `NOT (tags ?| …)`) so the memory package's quarantine exclusion is honored by the Postgres store. Additive.
