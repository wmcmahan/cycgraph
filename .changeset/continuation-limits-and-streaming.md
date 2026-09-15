---
"@cycgraph/orchestrator": patch
---

The empty-final continuation now honours the agent's `maxOutputTokens` and spends only what is left of its `maxSteps` budget, streams its recovered text through `onToken` so live consumers see the same answer that is stored, and logs `empty_final_continuation_failed` with the stream's root cause and any partial usage when the recovery call fails.
