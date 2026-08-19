---
"@cycgraph/orchestrator-postgres": patch
---

The `workflow_events.event_type` column type accepts the new `child_*` event types recorded by subgraph child-event threading. Text column, no migration required.
