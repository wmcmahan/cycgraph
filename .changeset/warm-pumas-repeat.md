---
"@cycgraph/orchestrator-postgres": minor
---

Report a missing run record instead of a raw constraint failure.

Every run-scoped table references the run row, which references the graph.
Executing without persisting those first made each durable write fail on a
foreign key, and the caller saw only a wrapped `Failed query: insert into
"workflow_events" …` per attempt followed by the event log halting — a symptom
that named neither the missing row nor the fix.

The event-log writer and both state writers now map SQLSTATE 23503 to
`MissingRunRecordError`, which names the run, the table, and the two calls that
resolve it. The SQLSTATE predicates move to a shared `pg-errors` module so the
unique-violation and foreign-key checks stay in one place.
