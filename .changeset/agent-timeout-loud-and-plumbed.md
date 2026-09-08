---
"@cycgraph/orchestrator": patch
---

Agent timeouts are now loud and configurable per node. The AI SDK resolves an aborted stream instead of rejecting it, so an agent hitting the 2-minute default stream timeout surfaced as a successful completion with an empty reply — it wrote no memory, and a retrying graph looped on an unchanged state at full spend. The executor now detects the abort after the stream settles and throws `AgentTimeoutError` with the partial usage. `GraphNode.failure_policy.timeout_ms` is also passed through to the agent's stream call, so a node granted twenty minutes is no longer cut off at two by the process-wide default.
