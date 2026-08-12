---
"@cycgraph/orchestrator": minor
---

Engine hardening across the delegation and permission layers: subgraph
output-mapping targets are implied write grants; supervisors derive reads
from managed nodes' implied result keys; the graph validator warns on tool
nodes declaring inert `write_keys` and reflection `source_keys` nothing
produces; boundary crossing logic (mapping, taint, interface enforcement)
extracted to a module shared by delegating nodes; `subgraph.run` and
`a2a.task` tracing spans with an `injectTraceContext` helper for outbound
W3C trace propagation.
