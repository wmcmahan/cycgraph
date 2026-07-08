---
"@cycgraph/memory": minor
---

Poisoning-resistance fixes for consolidation, conflict resolution, and retrieval, plus a first-class quarantine concept.

**Deduplication no longer evicts trusted lessons.** `MemoryConsolidator` keeper selection now prefers a `verified` (gate-promoted) fact over an unverified one, then higher `access_count`, then more source episodes, then recency — so a fresh (or poisoned) near-duplicate written with a newer timestamp can no longer invalidate a proven lesson. When a duplicate is merged, the loser's evidence (`access_count`, `tags`, `source_episode_ids`) is now folded into the survivor instead of dropped, and merges accumulate correctly when one fact absorbs several duplicates. New `verifiedTag` / `candidateTag` options on `ConsolidationOptions`.

**Conflict resolution respects recency.** The `negation-invalidates-positive` policy now resolves by temporal order — a newer positive correction ("X is now safe") survives a stale negation ("X is not safe"), and a newer negation still invalidates an older positive; the negation bias only breaks a timestamp tie. Previously a stale negation always won, silently killing later corrections.

**Detection is side-effect-free by default.** `ConflictDetector.detectConflicts()` no longer mutates the store as a side effect: `autoResolveSupersession` now defaults to `false`. **Note:** callers that relied on `detectConflicts()` auto-invalidating superseded facts must now opt in (`autoResolveSupersession: true`) or resolve explicitly via `autoResolveAll()`.

**Quarantine (new).** A well-known `QUARANTINE_TAG` export and a new `exclude_tags` field on `FactFilter` (AND-NOT semantics). Gated retrieval, consolidation, and conflict detection exclude quarantined facts by default, so a fact learned during a failed/poisoned run can no longer resurface as a trusted lesson or be promoted by the gate. Additive; facts are excluded from reads but remain recoverable for audit.
