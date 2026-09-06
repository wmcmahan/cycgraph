---
"@cycgraph/orchestrator": patch
---

Agent executions on providers that report only input and output token
counts — Anthropic among them — no longer record zero total tokens.
The agent executor now derives the total when the provider omits it,
matching what the supervisor executor already did, so cost accounting
and token budgets apply to those runs instead of silently passing
everything.
