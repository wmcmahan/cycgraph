---
"@cycgraph/orchestrator": minor
---

Supervisors derive their read grants from their team. A `supervisor` node with no declared `read_keys` now sees `goal`, `constraints`, and everything its `managed_nodes` write (their `write_keys` plus each node's `${id}_output` fallback) — instead of routing blind on `goal`/`constraints` alone. This removes the `reads: ['*']` boilerplate every supervisor example hand-wrote, and it is least-privilege where the wildcard was not: tainted memory outside the team's outputs never reaches the routing prompt. Explicit `read_keys` on a supervisor override the derivation entirely, and non-supervisor nodes are unchanged. Together with the already-implied `handoff`/`set_status` write permissions, a typical supervisor now declares no grants at all.

The security policy gate evaluates the same derived grants: a `securityPolicy` sees a grant-less supervisor's derived reads in `tainted_read_keys`, so tainted managed-node output cannot reach the routing prompt unexamined.
