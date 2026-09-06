---
"@cycgraph/orchestrator": patch
---

The built-in Anthropic model registry and pricing table now know the
Claude 5 family — `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`
— so agent configs naming them validate and cost accounting prices them
($5/$25, $2/$10, and $10/$50 per MTok respectively) without a manual
`registry.addModel` call.
