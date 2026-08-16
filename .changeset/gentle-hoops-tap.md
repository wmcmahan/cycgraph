---
"@cycgraph/orchestrator": minor
---

Taint now records lineage and announces itself.

`TaintMetadata` gained `derived_from`, `node_id`, and `bytes`. Propagation already established which input keys were tainted and then discarded that, so a `derived` entry said only that something upstream was untrusted. It now names the keys it came from, and a chain like `final ← draft ← research_notes ← custom_tool` can be walked back to the tool or remote agent that introduced the data.

A new `taint:applied` stream event and matching `taint_applied` log line fire when a key is first tainted, carrying the source, server, tool, lineage, and size. Untrusted data entering a run was previously observable only by diffing state snapshots, so nothing could alert or filter on it.

Fan-out aggregation recorded the fan-out node's id in `agent_id`; it now uses `node_id`. Anything reading `agent_id` on an aggregate taint entry should read `node_id`.
