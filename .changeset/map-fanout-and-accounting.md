---
"@cycgraph/orchestrator": patch
---

Fan-out and accounting hardening for map nodes and agent executions:

- Map workers now honor their node's `failurePolicy.timeoutMs` instead of always running under the executor's 2-minute default.
- The map executor stops dispatching new workers once projected spend would cross the run's token budget; skipped items are reported in the node's error output and completed work survives instead of the whole run failing after the fact.
- Workers' lesson provenance is hoisted from their nested update payloads to the merged action, so fan-out retrieval is attributable to run outcomes like any other node.
- Multi-step agents whose final step produces no text now fall back to the last step that did, instead of silently discarding the answer written mid-loop.
- Usage accounting carries prompt-cache detail end to end: the per-step usage fallback keeps `inputTokenDetails`, actions carry `cacheReadTokens`/`cacheWriteTokens` (map merges included), `calculateCost` prices cache reads at 10% and writes at 125% of the input rate, and the `token_usage` log line names its source (`aggregate` or `step_sum`).
- `reflection()` accepts an `agent()` value for the LLM extractor's `agentId`, like every other agent reference.
