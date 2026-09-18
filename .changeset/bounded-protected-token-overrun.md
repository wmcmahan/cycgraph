---
"@cycgraph/context-engine": patch
---

`pruneByScore` now caps the cost of protected tokens (negations) at twice `maxTokens` instead of keeping them unconditionally, so text dense with negations can no longer overrun the budget without limit. Protected tokens are admitted highest-scored-first up to that ceiling.
