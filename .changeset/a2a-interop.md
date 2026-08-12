---
"@cycgraph/orchestrator": minor
"@cycgraph/a2a": minor
---

Agent2Agent (A2A) interop: delegate a graph step to a remote agent.

New `a2a` node type, sibling to `subgraph`: same mapping convention and
implied write grants, but budget and capability ceilings deliberately stop
at the network boundary and everything returned is taint-tracked. A remote
`input-required` pauses the run through the existing HITL machinery and
resumes the same remote task, including when nested inside a subgraph.
`rejected` and `auth-required` tasks are classified non-retryable.

Supporting pieces: a trusted `A2AServerRegistry` (SSRF-guarded Agent Card
URLs, credentials as named env vars, per-server `propagateTraceContext`),
an `A2AClient` port so core carries no protocol dependency, `toAgentCard` /
`agentCardFidelity` for publishing a graph's interface, and the new
`@cycgraph/a2a` package implementing the port on `@a2a-js/sdk`.
