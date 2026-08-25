---
"@cycgraph/orchestrator": patch
---

Subgraph child nodes surface on the telemetry channel: a new `GraphRunnerOptions.onChildNode` seam reports namespaced `node:start`/`node:complete` lifecycle events (one path prefix per nesting hop) to the outermost runner's stream, and child log lines carry the same namespaced `node_id`, so a nested run's boundaries stay attributable end to end.
