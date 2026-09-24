---
"@cycgraph/orchestrator": patch
---

The agent executor's `token_usage` log line now carries `model`, the concrete model the call ran on after tier resolution, so per-model spend is readable from a run log.
