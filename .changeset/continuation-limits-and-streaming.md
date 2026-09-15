---
"@cycgraph/orchestrator": patch
---

Tool calls made during the empty-final continuation now emit `onToolCall`/`onToolCallComplete` events, so live consumers no longer see a silent gap while an agent recovers by calling a tool. The continuation also shares the primary call's model, tool and limit options, so any option added later reaches both requests.

