---
"@cycgraph/orchestrator": minor
---

Upgrade to Vercel AI SDK v7.

The engine now runs on `ai@7`, and the provider packages move to their v7-compatible majors: `@ai-sdk/anthropic@4`, `@ai-sdk/openai@4`, and `@ai-sdk/mcp@2`. Internal call sites were updated to the v7 names (`instructions`, `isStepCount`, `onToolExecutionStart` / `onToolExecutionEnd`). The exported orchestrator API is unchanged.
