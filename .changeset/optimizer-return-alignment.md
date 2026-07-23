---
"@cycgraph/context-engine": minor
---

`createOptimizedPipeline` is now aligned with `createPipeline` and `createIncrementalPipeline` in both return shape and options.

- **Return shape**: the factory returns the pipeline itself — call `.compress()` directly on the return value. The optimizer's decisions remain available as properties on the same object (`preset`, `stageNames`, `stages`). Existing call sites keep working: a deprecated self-referential `pipeline` property preserves the old `const { pipeline } = createOptimizedPipeline(...)` shape and will be removed in the next major.
- **Options**: `OptimizerOptions` gains `logger` and `timeoutMs`, forwarded to the underlying pipeline — the safety rails documented for `createPipeline` are now reachable from the preset entry point.
- **Deprecations**: `compressionProvider` and `embeddingProvider` on `OptimizerOptions` were never wired to any preset stage (self-information pruning and semantic dedup require explicit `createPipeline` composition). They are now marked deprecated — accepted for type compatibility, ignored at runtime as before — and will be removed in the next major.
