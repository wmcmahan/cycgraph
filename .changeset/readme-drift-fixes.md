---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
"@cycgraph/memory": minor
"@cycgraph/context-engine": minor
---

Documentation overhaul: package READMEs audited against source and brought back in sync with the shipping API.

- **orchestrator-postgres**: README examples rewritten against the current API — adapter constructors no longer show the removed `{ db }` option (module-level `getDb()` singleton), `saveUsageRecord` replaces the nonexistent `usageRecorder.record()`, bulk `archiveCompletedWorkflows()`/`deleteWarmData()`/`getStorageStats()` replace the nonexistent per-run `archiveRun()`, `dequeue(workerId)` signature corrected, `getInjectedFactIds` now imported from `@cycgraph/orchestrator` (not `@cycgraph/memory`), and `DrizzleMCPServerRegistry` documented.
- **context-engine**: README now lists the real pipeline presets (`fast` / `balanced` / `maximum`) and real stage options (`threshold`, `forceShape`, `truncationSuffix`); fixed a syntax error in the `contextCompressor` example.
- **memory**: fixed a syntax error in the `retrieveMemory` example; gate-simulator timing claim aligned with measured behavior.
- **orchestrator**: Subgraph pattern link retargeted to an existing docs page; `evolution-regex` added to the examples index; canonical registration examples use the camelCase authoring API.
