---
"@cycgraph/orchestrator-postgres": minor
---

Durable eval-gated learning ledger. New `DrizzleOutcomeLedger` implements `@cycgraph/memory`'s `OutcomeLedger` interface against Postgres, so run-outcome evidence survives restarts — the substrate eval-gating needs to accumulate the trial counts its operating-characteristics curves require (the in-memory ledger forgets everything on restart). Per-fact stats and the leave-one-out baseline are computed by SQL aggregation at query time (`count` / `avg` / `var_samp`), reproducing `InMemoryOutcomeLedger` exactly: `var_samp` matches the in-memory `(n−1)` sample variance and is NULL for n < 2 (→ `variance: undefined`). Anywhere the gate or retriever takes an `OutcomeLedger`, this drops in as a one-line swap.

**Schema (migration `0016_add_outcome_ledger`):** `run_outcomes` (one scored run), `run_outcome_facts` (run→injected-fact join; composite PK `(run_id, fact_id)` enforces within-run dedup and makes leave-one-out a clean `NOT EXISTS`), and `gate_decisions` (append-only audit of every retention-gate decision with its statistical `evidence`).

**Observability read APIs:** `recordGateDecisions(report)` persists a gate pass (append-only — re-running logs history, it doesn't overwrite); `listGateDecisions(filter)`, `getLessonHistory(factId)`, and `getFitnessTrend(opts)` let an operator audit what the self-improving system promoted, evicted, or held — and why — plus the workflow's fitness trend over time. New exports: `DrizzleOutcomeLedger`, and the `GateDecisionFilter` / `FitnessTrendPoint` types.

Still caller-driven: durability does not auto-wire `recordOutcome` / `evaluateRetention` into the runner lifecycle (that remains an explicit next slice). No `@cycgraph/memory` changes — the adapter only imports its interface and types.
