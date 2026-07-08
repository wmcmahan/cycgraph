# @cycgraph/context-engine

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
