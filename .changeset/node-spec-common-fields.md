---
"@cycgraph/orchestrator": patch
---

Fix: `subgraph()` and `a2a()` rejected the common node fields.

Both helpers shipped accepting only their own mapping options, so a node
authored through them could not declare `failurePolicy`, `budget`,
`metadata`, or `requiresCompensation` — fields `node()` has always accepted.
Setting a retry policy on a subgraph or remote-agent node meant abandoning the
helper and hand-authoring the node. Every spec now extends a shared
`NodeCommon` base, which is a widening and breaks nothing.

`A2ASpec` deliberately excludes `budget`. A per-node cap is measured against
the tokens and cost a node reports, and the a2a executor reports none: a
remote agent's spend happens on infrastructure this engine cannot meter, so
the cap could never fire. `maxWaitMs` and the failure policy are the bounds
that do apply there.
