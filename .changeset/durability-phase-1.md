---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
---

Durability hardening (Phase 1): make crash recovery, idempotency, and multi-worker execution actually safe.

**Deterministic replay.** Reducers now derive every timestamp (`started_at`, `updated_at`, approval deadlines, history entries) from `action.metadata.timestamp` instead of `new Date()`, so event-log replay reconstructs byte-identical state. `applyHumanResponse` logs its `resume_from_human` action durably (resumed runs previously lost the human decision). `workflow_started` carries a `REPLAY_VERSION` stamp recovery checks for reducer-semantics drift.

**State hydration.** New `hydrateWorkflowState()` (barrel-exported) runs at every load boundary — coerces jsonb date strings back to `Date`, applies `state_schema_version` migrations, and refuses snapshots from a newer engine. Fixes the bug where a recovered HITL workflow compared `new Date() >= waiting_timeout_at` against a *string* (always false), so approval timeouts never fired after recovery.

**Authoritative event log.** Appends are awaited behind a flush barrier before each state snapshot commits (events can no longer silently lag the snapshot they anchor). Duplicate `(run_id, sequence_id)` appends are rejected with the new `EventSequenceConflictError` instead of being silently dropped (Postgres) or duplicated (in-memory) — the two implementations now match. Recovery validates the log is gap-free (`EventLogCorruptionError` on a lost append) and the worker reconciles event-log replay against the latest snapshot, resuming from whichever reflects more progress.

**Unified idempotency.** One key space (`node_id:iteration`) checked before execution; a node whose action was applied before a crash (post-reduce/pre-advance window, detected via the snapshot's new `_last_event_sequence_id` high-water mark) is skipped on resume instead of re-executed. `MemoryWriter` now receives an `idempotency_key` (`run_id:node_id:iteration`) so reflection facts stop duplicating in long-term memory on retry/recovery.

**Durable queue + run fencing.** New `DrizzleWorkflowQueue` (migration `0014`, `workflow_jobs` table) with `FOR UPDATE SKIP LOCKED` atomic claims. Every claim bumps a `claim_epoch` on the run; `createFencedRunnerOptions(job)` builds fenced persistence/event-log writers that reject stale-epoch writes with the new `StaleClaimError` — a reclaimed worker can no longer clobber the new claimant (split-brain). The worker emits `job:claim_lost` and leaves the job untouched. `worker.stop()` now hard-cancels runners past the grace period before releasing jobs, and shutdown-interrupted jobs stay `active` for visibility-timeout reclaim. `InMemoryWorkflowQueue` mirrors the epoch semantics for parity.

New barrel exports: `hydrateWorkflowState`, `CURRENT_STATE_SCHEMA_VERSION`, `REPLAY_VERSION`, `EventSequenceConflictError`, `StaleClaimError`. New Postgres exports: `DrizzleWorkflowQueue`, `createFencedRunnerOptions`, `DrizzlePersistenceProviderOptions`, `RunClaim`, `DrizzleEventLogWriterOptions`.
