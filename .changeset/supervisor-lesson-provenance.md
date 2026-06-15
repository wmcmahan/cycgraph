---
"@cycgraph/orchestrator": minor
---

Supervisor-node lesson provenance. Closes the v1 gap where facts retrieved into a supervisor's routing prompt left no trace in `memory._lesson_provenance`, so supervisor-driven retrieval could never be attributed to a run's outcome (eval-gated learning silently ignored it). Supervisor nodes now mint a provenance entry for the injected facts at action-creation time and carry it on the `handoff` / `set_status` action they emit; `handoffReducer` / `setStatusReducer` merge it into the registry append-only with the same anti-clearing + ring-buffer-trim discipline `mergeMemory` applies to `update_memory` actions. `getInjectedFactIds(finalState)` now includes supervisor-injected facts, so the whole graph — agent, voting, evolution, and supervisor nodes — is uniformly attributable.

Replay-safe (entries minted in the persisted action payload, reducer is pure; existing logs lacking the field are unchanged, so no `REPLAY_VERSION` bump). Only facts whose retriever supplied an `id` are recorded, matching the agent-node contract. New schema fields: optional `lesson_provenance` on `HandoffPayloadSchema` and `SetStatusPayloadSchema` (additive — non-supervisor emitters omit it).
