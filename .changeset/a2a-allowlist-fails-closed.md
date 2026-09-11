---
"@cycgraph/orchestrator": patch
---

The `a2a` node now denies access when a server's `allowed_agents` list is non-empty and the node declares no `agent_id`, matching the MCP allowlist behavior. Previously omitting `agent_id` bypassed the allowlist entirely; graphs that relied on that must now set `agent_id` on restricted `a2a` nodes.
