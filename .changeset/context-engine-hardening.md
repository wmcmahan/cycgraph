---
"@cycgraph/context-engine": minor
---

Correctness hardening and honest provenance across the compression pipeline. Two behavior changes to know about, then the fixes and additions.

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
