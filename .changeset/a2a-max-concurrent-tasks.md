---
"@cycgraph/orchestrator": patch
---

The `max_concurrent_tasks` field on an A2A server registry entry is now enforced: the `a2a` node holds a per-server slot for the whole remote exchange, so a `map`, voting, or parallel-branch graph queues instead of firing every branch at one remote agent at once. Servers without the field are unchanged and still fan out freely.
