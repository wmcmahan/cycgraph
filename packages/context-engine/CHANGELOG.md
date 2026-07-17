# @cycgraph/context-engine

## 0.5.0

### Minor Changes

- 8d0d613: Correctness hardening and honest provenance across the compression pipeline. Two behavior changes to know about, then the fixes and additions.

  **Behavior changes**

  - **The budget allocator enforces budgets by token importance, not position.** An over-budget prose segment now keeps its most important tokens (entities, quantities, dates, protected negations) in original order instead of its earliest ones — tail truncation silently deleted trailing facts (including negations the pruner had deliberately protected) while leading filler survived. Structured segments (memory/tools roles, JSON) still tail-truncate cleanly; pass `truncation: 'tail'` to restore the old behavior everywhere, or supply a custom `scorer`. Measured effect: the `fast` preset went from losing 3/5 trailing facts on filler-heavy prose to preserving 5/5 at the same budgets.
  - **Undeclared stage `scope` now defaults to cross-segment** (was per-segment). A custom stage that never declared `scope` keeps producing correct output but loses per-segment caching in the incremental pipeline — declare `scope: 'per-segment'` to opt back in (only valid when each segment's output depends solely on its own content). This closes a recurring bug class where cross-segment stages (budget shares, dedup state, corpus statistics) silently ran on the fresh-segment subset. All built-in per-segment stages now declare their scope explicitly, so preset users are unaffected.
  - **`ModelProfile` drops `supportsNested` and `charsPerToken`** (both dead — nested is the universal fallback, and token ratios live in `MODEL_FAMILY_RATIOS`). The remaining fields are now wired: `applyCachePolicy({ model })` adds no locks when the provider has no prompt cache, and `compress()` warns when `budget.maxTokens` exceeds the model's context window.

  **Fixes**

  - Incremental pipeline: cache keys now cover `priority`, `locked`, and `metadata` (not just content); stages a cross-segment stage removed are no longer resurrected on fully-cached turns; headline metrics on partially-cached turns report full-prompt totals instead of fresh-subset ones; interleaved per-/cross-segment configs log a construction-time warning (execution is two-phase: per-segment first).
  - Batch pipeline: locked segments' tokens are charged against the budget stages receive; stages that remove or introduce segments are honored instead of silently undone.
  - Pruning and allocation stages declare `scope: 'cross-segment'`; the circuit breaker propagates the wrapped stage's scope.
  - Format: tabular shape detection is collision-proof for keys containing commas; deeply nested cell values serialize as JSON instead of `[object Object]`; flat-object values containing newlines are quoted.
  - Graph serializer: tabular mode requires every multi-entity type group to be uniform (ragged groups fall back to lossless adjacency instead of silently dropping attributes); cells with spaces (entity names like "Alice Johnson") are CSV-quoted.
  - Semantic dedup: structured (JSON/CSV) segments are excluded from the dedup pool, matching exact and fuzzy dedup — near-duplicate records can no longer be deleted out of a JSON payload.
  - Format selector: `customProfiles` is honored (matched by prefix before built-ins); models without tabular support get nested output as intended; the `maximum` preset no longer re-formats the selector's compact-JSON output for JSON-preferring models.
  - Preset stage order: CoT distillation runs before the dedup stages, keeping all presets per-segment-first.
  - Heuristic scorer recognizes uppercase identifiers with digits/hyphens (`MERIDIAN-7`, `SOC-2`, `GPT-4`) as entities — previously only pure acronyms matched, so such identifiers could be pruned under tight budgets.

  **Additions**

  - Debug source maps are now real provenance: `changedBy` (stages that modified each segment, in order), `removed`/`removedBy`, `addedBy`, and `fromCache` — threaded through the incremental pipeline so fully-cached turns still report how their output was derived.
  - `measurePrefixStability` + `computePrefixHashList`: position-sensitive cache stability (a change at position k invalidates everything after it), complementing the set-based `measureCacheHitRate` upper bound.
  - `StageContext.logger`: stages emit diagnostics through the pipeline's logger, falling back to console for must-see warnings.
  - `createTiktokenCounter` memoizes counts (bounded LRU, `cacheSize` option) so unchanged segments aren't re-encoded at every stage boundary.
  - `createOptimizedPipeline` returns the composed `stages` array for reuse with `createIncrementalPipeline`.

## 0.4.0

### Minor Changes

- b69cb1f: Documentation overhaul: package READMEs audited against source and brought back in sync with the shipping API.

  - **orchestrator-postgres**: README examples rewritten against the current API — adapter constructors no longer show the removed `{ db }` option (module-level `getDb()` singleton), `saveUsageRecord` replaces the nonexistent `usageRecorder.record()`, bulk `archiveCompletedWorkflows()`/`deleteWarmData()`/`getStorageStats()` replace the nonexistent per-run `archiveRun()`, `dequeue(workerId)` signature corrected, `getInjectedFactIds` now imported from `@cycgraph/orchestrator` (not `@cycgraph/memory`), and `DrizzleMCPServerRegistry` documented.
  - **context-engine**: README now lists the real pipeline presets (`fast` / `balanced` / `maximum`) and real stage options (`threshold`, `forceShape`, `truncationSuffix`); fixed a syntax error in the `contextCompressor` example.
  - **memory**: fixed a syntax error in the `retrieveMemory` example; gate-simulator timing claim aligned with measured behavior.
  - **orchestrator**: Subgraph pattern link retargeted to an existing docs page; `evolution-regex` added to the examples index; canonical registration examples use the camelCase authoring API.

## 0.3.0

### Minor Changes

- 8c0ed4b: Token pruning no longer corrupts structured content.

  The score-based pruning stage (used by the heuristic and self-information pruners, and the default `balanced` / `maximum` presets) dropped low-scoring whitespace-delimited tokens from any over-budget segment. That is meaning-preserving lossy compression for prose, but it **corrupted structured data** — dropping a key, value, or delimiter from serialized memory produced malformed output (e.g. `{"score": , "fact_id":"abc"}`) that the consuming model silently misread.

  Pruning now skips structured segments: gated by role (`memory` / `tools` — format-independent, so it survives the format stage rewriting JSON into a compact non-JSON shape) with a JSON content-sniff backstop. An over-budget structured segment is passed through intact and compressed by the structure-aware stages (format, dedup) instead of being token-pruned.

## 0.2.0

### Minor Changes

- c6cb931: Compression correctness fixes.

  - **Incremental cache key now includes the budget and model.** The incremental pipeline keyed cache reuse on segment content alone, so the same content compressed under a smaller budget (or a different model) returned the previous, larger output — overflowing the provider's context window. A budget+model fingerprint now invalidates the cache when either changes.
  - **Exact and semantic dedup are marked `cross-segment`.** Both dedup across all segments but were treated as per-segment, so the incremental pipeline ran them on the fresh-segment subset only — batch and incremental produced different output for identical input, and a duplicate spanning a cached + a fresh segment survived.
  - **Structured content is no longer corrupted by dedup.** Exact and fuzzy dedup skip JSON/CSV-shaped segments, so repeated structural lines (`},`, identical rows, duplicate imports) are no longer dropped into invalid JSON or lost data rows.
  - **Truncation is Unicode-safe.** Budget-driven truncation no longer cuts between a UTF-16 surrogate pair, which would emit a lone surrogate (U+FFFD) at the provider.
  - **Large inputs no longer overflow the stack.** The n-gram scorer computes min/max with a loop instead of `Math.min(...scores)`, which threw `RangeError` on token-granularity inputs with hundreds of thousands of scores (silently turning the pruner into a passthrough on exactly its largest inputs).

- c6cb931: Packaging: shared libraries moved to peer dependencies, and the Node engine floor lowered to 22.

  **BREAKING — install-time.** Libraries that a consumer composes against the packages' own objects are now `peerDependencies` and must be installed by the consumer:

  - `zod` (`@cycgraph/orchestrator`, `@cycgraph/memory`, `@cycgraph/context-engine`) — these packages export Zod schemas that consumers parse with and compose into their own schemas.
  - `ai` (`@cycgraph/orchestrator`) — the package exports `LanguageModel` types from the AI SDK.
  - `drizzle-orm` (`@cycgraph/orchestrator-postgres`) — the package exports Drizzle table objects (`export * from './schema'`) that consumers query with their own Drizzle operators (`eq`, `sql`, …). Drizzle tags tables/columns with internal Symbols, so two copies at different versions break at runtime; a single shared copy is required.

  Most consumers already depend on these directly, so no change is needed. A consumer that relied on them being installed transitively must now add them to its own `dependencies`.

  **OpenTelemetry is now optional.** `@opentelemetry/api` remains a dependency (it no-ops without an SDK), but the heavy `@opentelemetry/sdk-node`, exporters, `sdk-metrics`, `resources`, and `semantic-conventions` are now **optional** peer dependencies. Tracing/metrics are already loaded via dynamic `import()` only when enabled, so a deployment that doesn't export telemetry no longer installs the full OTel stack. Install them to enable trace/metric export.

  **Node `engines` floor lowered from `>=24` to `>=22`.** The packages run on Node 22 LTS (the whole test suite runs on it), so this only widens compatibility — Node 22 consumers no longer get `EBADENGINE` warnings.

## 0.1.0
