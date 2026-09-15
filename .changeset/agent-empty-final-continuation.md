---
"@cycgraph/orchestrator": patch
---

An agent turn that ends on an empty final step — the model received its tool results and went silent — now gets one bounded continuation asking it to finish, instead of having the turn's opening narration promoted to its final answer by the last-spoken fallback. The continuation runs with the agent's own model settings, spends only what is left of its `maxSteps` budget, and reports through the same `onToken` and tool-call callbacks as the primary call, so live consumers see exactly the text and tool activity that reach state; recovery is logged as `empty_final_continuation` and a failed recovery as `empty_final_continuation_failed` with the stream's root cause and any partial usage.
