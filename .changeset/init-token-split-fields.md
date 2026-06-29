---
"@cycgraph/orchestrator": patch
---

Initialize the `total_input_tokens` / `total_output_tokens` split fields to `0` when constructing workflow state on crash recovery (`runner/recover.ts`) and in the eval runner. Without this, recovered and eval runs started with these counters undefined, so the input/output token breakdown could read as missing rather than zero. Aggregate `total_tokens_used` was unaffected.
