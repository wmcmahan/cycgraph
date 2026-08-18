---
"@cycgraph/orchestrator": patch
---

Fix three cases where a run could not be replayed from its own event log. All three break crash recovery, not only forking.

**A human approval with no attached data made a run unrecoverable.** `ResumeFromHumanPayloadSchema.response` was `z.unknown()`, and under Zod 4 that no longer makes a key optional. `HumanResponse.data` *is* optional, so a bare approval produces `response: undefined` — and JSON drops that key on the way into the event log. Every such run then failed validation on replay. `recoverGraphRunner` included: any workflow where a reviewer clicked approve without attaching anything could not be recovered after a crash.

**The same trap in `tool_executions`.** `args` and `result` were required `z.unknown()`, so a tool called with no arguments, or returning nothing, produced a recorded action the run could not replay.

**Seeded input memory was lost on replay.** Memory supplied in a run's input is written by no action, so the event log held no record of it and replay began from an empty blackboard. `workflow_started` now records the seed and both replay paths read it. Logs written before this recover with an empty blackboard, which is the previous behaviour and the best available for them.

The general rule, now in the coding standards: a schema field that can legitimately be `undefined` **and** round-trips through the event log must be `.optional()`, because `z.unknown()` does not imply it and JSON drops the key.

Also fixed: comparing state across a durable round-trip. Postgres `jsonb` does not preserve object key order, so a value read back is field-reordered relative to the value the run held, and `JSON.stringify` reported two identical states as different. Comparison is now canonical (`canonicalJson` / `canonicalEquals`, exported for anything else doing the same).
