---
"@cycgraph/orchestrator-postgres": minor
---

Fenced-worker tenant scoping, checkpoint fencing, and durable-queue hardening.

- **The fenced worker write path is now tenant-scoped.** `createFencedRunnerOptions` threads the job's `tenant_id` into the persistence and event-log writers, so a hosted worker stamps every `workflow_states` / `workflow_events` / `workflow_checkpoints` row with the job's tenant (and runs its writes inside `withTenant`) instead of collapsing all tenants' run history into the seed tenant via the owner connection.
- **`checkpoint()` is fenced.** Checkpoint writes now verify the run's claim epoch under `FOR SHARE`, matching `append`/`compact` (factored into a shared guard). A stale/reclaimed worker can no longer write a checkpoint that becomes the recovery anchor for a run a new claimant owns (which would silently resume it from divergent state).
- **Poison-pill jobs dead-letter.** `reclaimExpired` applies the same `attempt >= max_attempts` exhaustion check `nack` uses, so a job whose worker dies hard (SIGKILL/OOM, no `nack`) is dead-lettered after `max_attempts` instead of being reclaimed and re-dequeued forever.
- **Retry backoff.** A `nack`ed job backs off before it can be re-dequeued (`dequeue` skips not-yet-visible jobs), configurable via `WorkflowQueueOptions` (`retryBackoffMs`, default 1000; `retryBackoffMaxMs`, default 5 min; `0` = immediate). **BREAKING (behavior):** retries are delayed by default.
- **Lifecycle ops verify ownership.** `ack`/`nack`/`heartbeat`/`release` accept an optional `workerId` and only mutate the job when it still owns it, so a stale worker can't ack/heartbeat a job a new claimant now owns.
- **Peer-dependency ranges widened.** `@cycgraph/orchestrator` and `@cycgraph/memory` peers are now `>=0.4.0 <1` / `>=0.2.0 <1` so any pre-1.0 core minor satisfies them — the next core minor no longer makes the published adapter uninstallable.
