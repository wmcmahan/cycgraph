---
"@cycgraph/orchestrator": patch
---

When a provider's aggregate usage promise reports nothing usable, the
agent executor now sums per-step usage instead of recording zero — and
logs `token_usage_missing` when even the steps carry none, so a
provider that hides its counts is visible instead of silently free.
