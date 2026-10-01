---
"@cycgraph/orchestrator": patch
---

Add Claude Sonnet 5.5 (`claude-sonnet-5-5`) and GPT-6.1 Sol (`gpt-6.1-sol`) to the built-in model lists and pricing table, both at $2 input / $10 output per million tokens. The built-in Anthropic and OpenAI providers rejected both IDs as unknown models; they now load, and their spend counts toward USD budgets.
