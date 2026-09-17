---
"@cycgraph/context-engine": patch
---

Fix the latency tracker scoring a stage whose average duration measures 0ms as zero efficiency, the worst possible score. Such a stage now reports `Infinity` when it saves tokens (and `-Infinity` when it adds them), so the circuit breaker no longer silently bypasses fast, effective compression stages for a full cooldown period.
