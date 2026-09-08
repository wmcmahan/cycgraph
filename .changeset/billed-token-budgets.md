---
"@cycgraph/orchestrator": minor
---

Token accounting and budgets now count billing-equivalent tokens. The
AI SDK reports cache reads inside `inputTokens` at full count while
Anthropic bills them at ~10% (and cache writes at 125%), so a budget
counting raw volume killed runs whose real spend was a fraction of the
number — the better the prompt cache hit, the more unfairly the budget
fired. `TokenUsage.totalTokens` is now the billed-equivalent total
(plain input + output when no cache detail exists), and the per-agent
`token_usage` log line reports cache reads, cache writes, and the
billed total.
