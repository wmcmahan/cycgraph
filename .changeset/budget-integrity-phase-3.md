---
"@cycgraph/orchestrator": minor
---

Budget integrity (Phase 3): make every LLM call count toward budgets and stop runaway spend mid-loop.

**Supervisor spend is now tracked.** Supervisor routing calls previously recorded NO `token_usage` on their handoff/completion actions, so every iteration's tokens were invisible to the token budget, cost budget, per-node budget, and usage records — on a 10-iteration loop that hid 100K–1M+ tokens. Handoff and completion actions now carry `token_usage` + `model`, so supervisor spend flows through the normal `_track_tokens`/`_track_cost` path.

**Supervisor prompt memory is byte-capped.** The supervisor prompt embedded the full memory blob with no size limit, so a loop that re-reads memory every iteration grew ~quadratically. It now uses the same `MAX_MEMORY_PROMPT_BYTES` (50KB) cap as agent prompts.

**Composite nodes stop spending mid-loop.** Per-node and workflow budgets were only checked AFTER a composite node's aggregated action returned — an evolution node ran its entire population × generations before the cap was even consulted. A new between-iteration budget guard (`checkCompositeBudget`) lets evolution and annealing stop early once accumulated token/cost spend crosses the node's `budget` or the remaining workflow budget. Evolution surfaces a `{nodeId}_budget_stopped` flag.

**Failed-attempt LLM spend is counted.** A node that retries N times previously counted only the successful attempt's tokens. The agent executor now attaches best-effort `partialUsage` to `AgentExecutionError`/`AgentTimeoutError`, and the runner dispatches `_track_tokens`/`_track_cost` for each failed attempt — so a `max_retries: 3` node can no longer hide up to ~4× its visible spend.

**Parallel task timeouts actually abort the LLM call.** Evolution/voting/map passed `executeParallel` a per-task timeout signal that the callers ignored, wiring only the workflow signal — so a `task_timeout_ms` left the underlying `streamText` running in the background, burning uncounted tokens. The callers now combine both signals (`combineAbortSignals`), so a task timeout cancels the LLM call.
