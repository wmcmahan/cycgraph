---
"@cycgraph/orchestrator": minor
---

Secure-by-default, budget/termination, durability, and API-surface hardening.

**Secure by default.** Several guardrails that only held if the host wired an optional hook now fail safe out of the box:

- **Architect publishing fails closed.** `architect_publish_workflow` is agent-reachable; publishing is now **denied** when neither `ArchitectToolDeps.canPublish` nor the new explicit `allowUnguardedPublish` opt-out is set, so a prompt-injected agent on an unconfigured host can't publish executable graphs. **BREAKING (behavior):** hosts that relied on unguarded publishing must set `allowUnguardedPublish: true` (trusted/local) or wire `canPublish`.
- **stdio MCP env is scrubbed.** Registry-supplied env is stripped of loader/interpreter-hijack vars (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHON*`, `BROWSER`) before spawn — the command allowlist only constrains the binary, not what it loads at startup.
- **Connect-time SSRF re-check.** http/sse MCP hosts are DNS-resolved at connect time and rejected if any address is private/loopback/metadata (defeating static DNS-rebinding), fail closed on lookup error, honoring the existing `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS` escape hatch. `isPrivateOrLoopbackHost` is now exported.
- **Tool errors are tainted.** A throwing MCP server's (attacker-influencable) error text now mints a taint entry just like a successful result, so `strict_taint` / security-policy gates fire on injection delivered through a tool error.

**Budget & termination.**

- **A node-level timeout no longer aborts the whole run.** Each node gets its own `AbortController`; a node timeout cancels only that node's in-flight work instead of the single shared workflow controller (which poisoned parallel siblings and irreversibly tripped the run loop).
- **Subgraph spend counts against the parent USD budget.** The child now inherits the parent's remaining `budget_usd`, and the subgraph action reports the child's already-summed cost via a new optional `token_usage.costUsd` (correct for multi-model children) that the parent adds directly and checks against `budget_usd`.
- **Map fan-out is bounded.** A `max_items` cap (default and hard ceiling `MAX_MAP_ITEMS = 1000`) fails a map node loudly when the resolved item count exceeds it, instead of issuing an unbounded number of LLM calls. Never silently truncates.

**Durability & queue.**

- **Queue lifecycle ops verify ownership.** `WorkflowQueue.ack`/`nack`/`heartbeat`/`release` take an optional `workerId`; when supplied, the op only applies if the worker still owns the job, so a stale/reclaimed worker can't ack/nack/heartbeat a run a new claimant owns. Additive (omitting `workerId` keeps the prior behavior).
- **Retry backoff.** A `nack`ed job now backs off (`visible_at = now + min(base·2^(attempt-1), cap)`) and `dequeue` skips not-yet-visible jobs, so a fast-failing job no longer burns its attempts in a tight loop. Configurable via a `WorkflowQueueOptions` constructor arg (`retryBackoffMs`, default 1000; `retryBackoffMaxMs`, default 5 min; `0` = immediate). **BREAKING (behavior):** retries are now delayed by default.
- **Poison-pill jobs dead-letter.** `InMemoryWorkflowQueue.reclaimExpired` applies the same `attempt >= max_attempts` check `nack` uses, so a job whose worker dies hard (no `nack`) is dead-lettered after `max_attempts` instead of being reclaimed forever.
- **Event-log gap no longer discards a recoverable run.** When replay-based recovery hits a sequence gap, the worker falls back to a valid state snapshot (authoritative on its own) instead of letting the corruption error dead-letter the job.

**API surface & packaging.**

- **`CycgraphError` base class.** All engine error classes now extend a shared, exported `CycgraphError`, so consumers can catch engine errors as a group (`catch (e) { if (e instanceof CycgraphError) … }`).
- **Public barrels are curated.** The `types` / `persistence` / `evals` barrels are now explicit named re-exports instead of `export *`, so a new symbol in a leaf file no longer auto-enters the semver surface. The current public surface is unchanged.
- **Dropped the unused `@ai-sdk/provider` direct dependency** (never imported in source), removing orchestrator's contribution to a duplicate-provider-version resolution.
