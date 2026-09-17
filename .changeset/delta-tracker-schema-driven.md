---
"@cycgraph/orchestrator": patch
---

`StateDeltaTracker` now diffs every top-level `WorkflowState` field (derived from the schema) instead of a hand-maintained list that predated the v1→v2 state migration: patches emitted between full snapshots previously dropped changes to the taint registry, lesson provenance, HITL/policy approvals, subgraph checkpoints, split token counters, and the event-log high-water mark — a patch-resumed run lost taint tracking and crash-window idempotency. Memory values are also deep-compared now, so unchanged object-valued keys no longer re-serialize into every patch.
