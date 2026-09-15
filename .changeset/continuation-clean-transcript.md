---
"@cycgraph/orchestrator": patch
---

The empty-final continuation no longer applies cache-mark rewriting to the transcript it re-sends: the recovery path hands the model the messages exactly as the SDK holds them, trading the cache discount on a rare path for maximum recovery reliability.
