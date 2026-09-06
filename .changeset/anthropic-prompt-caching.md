---
"@cycgraph/orchestrator": patch
---

Multi-step agent executions on Anthropic now advance a prompt-cache
breakpoint to the end of each step's message prefix, so the growing
transcript — tool results included — is re-read from cache instead of
re-billed in full on every step. Applies automatically when the
provider is anthropic and the agent's step cap exceeds two; single-shot
calls are untouched, since one request has nothing to hit.
