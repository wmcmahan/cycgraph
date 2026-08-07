---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": patch
---

Rename the `*Fn` runner options to noun-verb names: `persistState`, `loadGraph`, and `persistDelta` are now the primary `GraphRunnerOptions` fields. The former `persistStateFn` / `loadGraphFn` / `persistDeltaFn` remain as deprecated aliases (the primary name wins when both are given) and will be removed in a later release. `createFencedRunnerOptions` in `@cycgraph/orchestrator-postgres` now returns `persistState`; the worker accepts either spelling from `runnerOptionsFactory` results, so existing factories keep working.
