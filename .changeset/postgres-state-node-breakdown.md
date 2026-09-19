---
"@cycgraph/orchestrator-postgres": patch
---

Persisted state snapshots now include `node_breakdown`, so a run resumed or forked from Postgres keeps its per-node spend instead of resetting it to `{}` — tail-cost estimates, budget enforcement on forks, and per-node spend reporting stay correct across a restart.
