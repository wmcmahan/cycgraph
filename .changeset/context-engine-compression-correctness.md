---
"@cycgraph/context-engine": minor
---

Compression correctness fixes.

- **Incremental cache key now includes the budget and model.** The incremental pipeline keyed cache reuse on segment content alone, so the same content compressed under a smaller budget (or a different model) returned the previous, larger output — overflowing the provider's context window. A budget+model fingerprint now invalidates the cache when either changes.
- **Exact and semantic dedup are marked `cross-segment`.** Both dedup across all segments but were treated as per-segment, so the incremental pipeline ran them on the fresh-segment subset only — batch and incremental produced different output for identical input, and a duplicate spanning a cached + a fresh segment survived.
- **Structured content is no longer corrupted by dedup.** Exact and fuzzy dedup skip JSON/CSV-shaped segments, so repeated structural lines (`},`, identical rows, duplicate imports) are no longer dropped into invalid JSON or lost data rows.
- **Truncation is Unicode-safe.** Budget-driven truncation no longer cuts between a UTF-16 surrogate pair, which would emit a lone surrogate (U+FFFD) at the provider.
- **Large inputs no longer overflow the stack.** The n-gram scorer computes min/max with a loop instead of `Math.min(...scores)`, which threw `RangeError` on token-granularity inputs with hundreds of thousands of scores (silently turning the pruner into a passthrough on exactly its largest inputs).
