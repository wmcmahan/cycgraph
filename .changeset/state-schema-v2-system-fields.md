---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
---

State schema v2: engine-owned data moves out of the memory blackboard into first-class `WorkflowState` fields (`taint_registry`, `lesson_provenance`, `pending_approval`, `policy_approvals`, `subgraph_checkpoints`, `subgraph_stack`, `swarm_handoff_count`). Persisted v1 snapshots migrate automatically on load via `hydrateWorkflowState`. Reducers route the wire-format `_taint_registry` / `_lesson_provenance` payload keys to the new fields through a single choke point and drop unknown `_`-prefixed memory keys fail-closed (recorded in `memory_drops` with reason `reserved_key`).

Compound-pattern executors (map, voting, evolution, annealing, swarm) now deliver per-invocation inputs through a new `StateView.taskContext` channel, rendered into prompts as a `## Task Context` section. This fixes a latent bug where the old `_`-prefixed context keys were stripped from prompts by injection sanitization, so workers never saw their map item, evolution candidates never saw their parent or its critique, and annealing feedback never reached the LLM.

Breaking API changes: taint utilities are now registry-centric (`getTaintRegistry(state)`, pure `markTainted(registry, key, meta)`, `propagateDerivedTaint(memory, registry, outputKeys, agentId)`); HITL consumers read `state.pending_approval` instead of `memory._pending_approval`; swarm agents delegate via the writable `peer_delegation` memory key (the old `_peer_delegation` was unwritable by real agents) and swarm nodes require `control_flow` in `write_keys`.
