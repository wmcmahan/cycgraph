---
"@cycgraph/orchestrator": minor
---

Write permissions are now partially derived instead of fully hand-written. Node types imply their control-flow grants (supervisor: `handoff` + completion, approval/subgraph: HITL pause, swarm-config agents: peer handoff), and executor-owned result keys are implied by node config (verifier result pair, reflection envelope, tool `${id}_result`, map/voting/evolution aggregates). The `control_flow`/`status` pseudo-keys and result keys no longer need to appear in `write_keys` — declared keys remain the authority for what the node's agent writes, and redundant declarations stay valid. The derivation is exported as `effectiveWriteKeys()` / `impliedActionPermissions()` / `impliedResultKeys()`. `validateGraph` gains a dangling-read warning for `read_keys` entries nothing in the graph can produce, and drops the now-obsolete errors requiring pseudo-keys and result keys in `write_keys`.
