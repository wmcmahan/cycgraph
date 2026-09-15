---
"@cycgraph/orchestrator": patch
---

An agent turn that ends on an empty final step — the model received its tool results and went silent — now gets one bounded continuation asking it to finish, instead of having the turn's opening narration promoted to its final answer by the last-spoken fallback. Recovery is logged as `empty_final_continuation`.
