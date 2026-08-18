---
"@cycgraph/orchestrator": patch
---

Agents now sample at their configured `temperature`. The registry field was
documented and stored but never passed to the model call, so every agent,
supervisor, evaluator, and extractor ran at the provider's default and
`change.temperature` forks silently changed nothing. The effective temperature
is also logged per call (`agent.executor.executing`, supervisor `routing`),
and node-scoped log lines now carry `node_id` via the run context, so output
can be attributed to the conditions that produced it.
