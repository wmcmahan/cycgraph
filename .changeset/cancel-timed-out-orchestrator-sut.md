---
"@cycgraph/evals": patch
---

`runOrchestratorSut` now cancels a run that exceeds `timeoutMs` and waits for it to settle before returning. A timed-out trajectory can no longer keep making LLM and tool calls in the background while the next test reconfigures the process-global agent factory and provider registry.
