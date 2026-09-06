---
"@cycgraph/orchestrator": patch
---

`runRecorded` now persists the workflow run row before executing, not
just the graph. With a durable event log the first flush's appends were
refused for lack of a run record to reference, silently losing the
run's earliest events; in-memory writers never cared, which is how the
omission survived.
