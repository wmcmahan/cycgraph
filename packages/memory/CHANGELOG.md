# @cycgraph/memory

## 0.5.0

### Minor Changes

- b69cb1f: Documentation overhaul: package READMEs audited against source and brought back in sync with the shipping API.

  - **orchestrator-postgres**: README examples rewritten against the current API — adapter constructors no longer show the removed `{ db }` option (module-level `getDb()` singleton), `saveUsageRecord` replaces the nonexistent `usageRecorder.record()`, bulk `archiveCompletedWorkflows()`/`deleteWarmData()`/`getStorageStats()` replace the nonexistent per-run `archiveRun()`, `dequeue(workerId)` signature corrected, `getInjectedFactIds` now imported from `@cycgraph/orchestrator` (not `@cycgraph/memory`), and `DrizzleMCPServerRegistry` documented.
  - **context-engine**: README now lists the real pipeline presets (`fast` / `balanced` / `maximum`) and real stage options (`threshold`, `forceShape`, `truncationSuffix`); fixed a syntax error in the `contextCompressor` example.
  - **memory**: fixed a syntax error in the `retrieveMemory` example; gate-simulator timing claim aligned with measured behavior.
  - **orchestrator**: Subgraph pattern link retargeted to an existing docs page; `evolution-regex` added to the examples index; canonical registration examples use the camelCase authoring API.

## 0.4.0

### Minor Changes

- 8c0ed4b: Dedup preserves the loser's entity links.

  When `MemoryConsolidator` merges two near-duplicate facts, it now unions the loser's `entity_ids` into the survivor (alongside the existing episodes / tags / access-count merge). Previously the loser's entity links were dropped, so if the duplicates referenced different entities the survivor silently lost its link to the loser's — and entity-scoped retrieval and conflict detection (both group by `entity_id`) stopped seeing the merged fact for those entities.

## 0.3.0

### Minor Changes

- c6cb931: Poisoning-resistance fixes for consolidation, conflict resolution, and retrieval, plus a first-class quarantine concept.

  **Deduplication no longer evicts trusted lessons.** `MemoryConsolidator` keeper selection now prefers a `verified` (gate-promoted) fact over an unverified one, then higher `access_count`, then more source episodes, then recency — so a fresh (or poisoned) near-duplicate written with a newer timestamp can no longer invalidate a proven lesson. When a duplicate is merged, the loser's evidence (`access_count`, `tags`, `source_episode_ids`) is now folded into the survivor instead of dropped, and merges accumulate correctly when one fact absorbs several duplicates. New `verifiedTag` / `candidateTag` options on `ConsolidationOptions`.

  **Conflict resolution respects recency.** The `negation-invalidates-positive` policy now resolves by temporal order — a newer positive correction ("X is now safe") survives a stale negation ("X is not safe"), and a newer negation still invalidates an older positive; the negation bias only breaks a timestamp tie. Previously a stale negation always won, silently killing later corrections.

  **Detection is side-effect-free by default.** `ConflictDetector.detectConflicts()` no longer mutates the store as a side effect: `autoResolveSupersession` now defaults to `false`. **Note:** callers that relied on `detectConflicts()` auto-invalidating superseded facts must now opt in (`autoResolveSupersession: true`) or resolve explicitly via `autoResolveAll()`.

  **Quarantine (new).** A well-known `QUARANTINE_TAG` export and a new `exclude_tags` field on `FactFilter` (AND-NOT semantics). Gated retrieval, consolidation, and conflict detection exclude quarantined facts by default, so a fact learned during a failed/poisoned run can no longer resurface as a trusted lesson or be promoted by the gate. Additive; facts are excluded from reads but remain recoverable for audit.

- c6cb931: Packaging: shared libraries moved to peer dependencies, and the Node engine floor lowered to 22.

  **BREAKING — install-time.** Libraries that a consumer composes against the packages' own objects are now `peerDependencies` and must be installed by the consumer:

  - `zod` (`@cycgraph/orchestrator`, `@cycgraph/memory`, `@cycgraph/context-engine`) — these packages export Zod schemas that consumers parse with and compose into their own schemas.
  - `ai` (`@cycgraph/orchestrator`) — the package exports `LanguageModel` types from the AI SDK.
  - `drizzle-orm` (`@cycgraph/orchestrator-postgres`) — the package exports Drizzle table objects (`export * from './schema'`) that consumers query with their own Drizzle operators (`eq`, `sql`, …). Drizzle tags tables/columns with internal Symbols, so two copies at different versions break at runtime; a single shared copy is required.

  Most consumers already depend on these directly, so no change is needed. A consumer that relied on them being installed transitively must now add them to its own `dependencies`.

  **OpenTelemetry is now optional.** `@opentelemetry/api` remains a dependency (it no-ops without an SDK), but the heavy `@opentelemetry/sdk-node`, exporters, `sdk-metrics`, `resources`, and `semantic-conventions` are now **optional** peer dependencies. Tracing/metrics are already loaded via dynamic `import()` only when enabled, so a deployment that doesn't export telemetry no longer installs the full OTel stack. Install them to enable trace/metric export.

  **Node `engines` floor lowered from `>=24` to `>=22`.** The packages run on Node 22 LTS (the whole test suite runs on it), so this only widens compatibility — Node 22 consumers no longer get `EBADENGINE` warnings.

## 0.2.0

### Minor Changes

- 8f211cc: Eval-gated learning ("verified lessons"): lessons are now retained only if runs that used them verifiably score better.

  **@cycgraph/orchestrator — lesson provenance.** Retrieved memory facts can carry an `id` (`MemoryRetrievalResult.facts[].id`, optional and non-breaking). When present, the runner records which facts were injected into each node's prompt in an append-only `memory._lesson_provenance` registry (same replay-safe pattern as the taint registry; invisible to node StateViews). Voting and evolution forward provenance from every sub-agent — losing candidates count as trials too. New exports: `getInjectedFactIds(state)`, `getLessonProvenance(state)`, `getLessonProvenanceRegistry(memory)`, plus the `LessonProvenanceEntry` / `LessonProvenanceRegistry` types. Known v1 limitation: supervisor-node retrieval is not provenance-tracked.

  **@cycgraph/memory — outcome ledger, retention gate, gated retrieval.** New `OutcomeLedger` interface + `InMemoryOutcomeLedger` (`recordOutcome({ run_id, score, fact_ids })`, per-fact trial stats, leave-one-out baselines). New `evaluateRetention(store, ledger, policy)` promotes `candidate`-tagged lessons that lift outcomes past `promote_margin` (tag rewritten to `verified`), soft-evicts harmful ones (`invalidated_by: 'eval-gate:harmful'`), and retires no-lift candidates at `max_trials` — including ones deadlocked on an empty leave-one-out baseline. New `retrieveGatedLessons(store, options)` fills the prompt budget verified-first with candidate exploration slots, selected in-progress-first via the ledger, with a `rest_after_trials` bench phase so fully-trialled candidates create the absence runs their baseline needs.

  Runnable adversarial demo at `packages/evals/examples/eval-gated-learning/`: three deliberately poisoned lessons crater a run and the gate evicts all three on outcome evidence alone, two runs after injection.

- 131e3d3: Performance & scale (Phase 5): cut the cost of the hot paths and add the knobs to keep a long/large run bounded.

  **Tag-filtered fact retrieval is now an index lookup, not a table scan.** `FactFilter` gained a `tags` field; the hierarchical retriever pushes the reflection-loop's tag filter into the store instead of paging the whole table and filtering client-side. The Postgres store resolves it via `tags ?| array[...]` backed by a new GIN index on `memory_facts.tags` (migration `0015`) and now applies a deterministic `ORDER BY valid_from DESC, id` so `LIMIT/OFFSET` pagination is stable. The in-memory store honors the same `tags` filter (insertion-ordered, already stable). **Run `0015_add_memory_facts_tags_gin` before relying on tag retrieval at scale** — on a large live table prefer `CREATE INDEX CONCURRENTLY` out-of-band.

  **Evolution scores candidates in parallel** (bounded by the existing `max_concurrency`) instead of one evaluator call at a time — a generation now takes ~one evaluation's wall-clock, not N. It also stores per-candidate fitness **summaries** in `${node}_population` (index/fitness/reasoning) rather than every candidate's full output (the winner's full output already lives in `${node}_winner`), shrinking state and every checkpoint.

  **Memory retrieval is bounded and batched.** `extractSubgraph` gained a `max_entities` cap (default `DEFAULT_MAX_SUBGRAPH_ENTITIES = 500`) so a dense graph can't expand the BFS frontier near-exponentially, and it batch-fetches visited entities (`getEntities`) instead of one round-trip each.

  **Sanitize-after-truncate in prompt building.** Injection-sanitization is now the **last** transformation before memory/retrieved-memory is embedded — applied to exactly the bytes that reach the prompt (and to compressor output, which is now also byte-capped). Closes the window where truncating after sanitizing could leave a partial boundary artifact, and stops wasting sanitization on bytes that get dropped.

  **Delta tracker no longer loses patches on a failed persist.** `computeDelta` advances its baseline optimistically but stashes the prior baseline; the persistence coordinator calls the new `rollback()` if the write throws, so the next delta diffs against the last _durably persisted_ state (no lost changes, no skipped version numbers).

  **Auto-compaction is on by default.** `GraphRunnerOptions.compaction_interval` now defaults to `DEFAULT_COMPACTION_INTERVAL = 1000` (was `0`/disabled) when an `eventLog` is wired, so a long run can't grow the event log without bound. Compaction is recovery-safe (checkpoint + `loadEventsAfter`). Set `compaction_interval: 0` to retain full history and compact manually. The snapshot-resume idempotency rebuild is now checkpoint-aware — it loads only the tail after the latest checkpoint instead of the entire event history.

  **New `RateLimiter` port.** Inject `GraphRunnerOptions.rateLimiter` to pace LLM calls inside a provider's budget — awaited before every agent/supervisor/evaluator call at a single chokepoint (the implementation may delay to throttle or throw to reject; abortable; propagated into subgraphs). New exports: `RateLimiter`, `RateLimitRequest`, `RateLimitCallKind`.

  **Per-server MCP concurrency limit.** `MCPConnectionManager` accepts `default_max_concurrent_calls`, and `MCPServerEntry` gained `max_concurrent_calls`, bounding in-flight tool calls per server (via a FIFO semaphore) so a wide fan-out can't overwhelm one MCP server. Defaults to unlimited for compatibility.

- d3641f2: Compound learning: `reflection` node type + `MemoryWriter` + tag-based retrieval.

  **@cycgraph/orchestrator**

  - New `reflection` node type that distills `source_keys` from workflow memory into atomic facts and persists them via an injected `MemoryWriter`. Two extractor variants:
    - `rule_based` — deterministic sentence-level extraction, no LLM call
    - `llm` — uses the new `extractFactsExecutor` primitive via a structured-output agent
  - New `MemoryWriter` adapter type on `GraphRunnerOptions` (mirrors `MemoryRetriever`).
  - New `extractFactsExecutor` primitive (sibling to `evaluateQualityExecutor`) for LLM-based fact distillation.
  - New `memory_query` directive on `GraphNode` — declares per-node retrieval (text / entity_ids / tags / max_facts). When set, the runner calls `memoryRetriever` before agent / supervisor prompt construction and renders results into a `## Relevant Memory` section ahead of the workflow-state `<data>` block. Voting and evolution nodes propagate `memory_query` to synthetic sub-nodes automatically.
  - `MemoryRetriever` query type gained `tags?: string[]`.
  - New errors: `MemoryWriterMissingError` (barrel-exported).
  - New types barrel-exported: `MemoryWriter`, `MemoryWriterFact`, `MemoryWriterResult`, `FactExtractionResult`, `ReflectionConfig`, `MemoryQuery`.

  **@cycgraph/memory**

  - `SemanticFact.tags` and `MemoryQuery.tags` fields (both default `[]`).
  - New tag-only retrieval path in `retrieveMemory()` — list facts by tag, intersect tags, apply temporal validity, expand to themes and episodes. No embedding provider required.
  - Existing embedding and entity-based paths now also intersect with the `tags` filter.

  **@cycgraph/orchestrator-postgres**

  - New `memory_facts.tags` `jsonb` column (migration `0013_add_fact_tags`).
  - `DrizzleMemoryStore` and `DrizzleMemoryIndex` row mappers updated to read/write `tags`.

- First stable release — the "verified lessons" release. Workflows learn from every run (reflection → memory → retrieval), and lessons survive only if runs that used them verifiably scored better: lesson provenance in the runner, an outcome ledger, and a statistically-controlled retention gate (Welch inference, FDR control, sequential alpha-spending) with a shipping simulator to measure any policy's real detection and false-positive rates before trusting it. Guarded throughout by per-node budgets, taint tracking, least-privilege state slicing, and human-in-the-loop gates.
- 40787be: Statistically honest retention gate + validation simulator. The eval-gating gate's new default `decision_rule: 'inference'` replaces the point-estimate margin comparison with a Welch-style test on the lift vs the leave-one-out baseline (Student-t, Welch–Satterthwaite df), Benjamini–Hochberg FDR control across candidates per pass, and alpha-spending over doubling baseline brackets so repeated gating cannot inflate false positives (the peeking problem — measured at 25% false decisions before this control, 0–2% after). The legacy behavior remains one flag away (`decision_rule: 'margin'`).

  New `RetentionPolicy` fields: `promote_confidence` / `evict_confidence` (default 0.9), `noise_floor_sd`, `multiple_comparison` (`'bh'`|`'none'`), `sequential_control` (`'doubling'`|`'none'`), and `max_baseline_runs` — the baseline-side stopping rule that retires candidates the bracket penalty has made undecidable (required alongside `rest_after_trials`, which freezes trials so `max_trials` alone can never fire). `RetentionReport` entries now carry an `evidence` object (`lift`, `se`, `df`, `p_promote`, `p_evict`, `trials`, `baseline_runs`, `alpha_bracket`); `promoted` entries changed from `string[]` to `{ fact_id, evidence? }[]`. `FactStats`/`OutcomeBaseline` gain `variance` (breaking for third-party `OutcomeLedger` implementers). `retrieveGatedLessons` gains `rest_after_trials` — candidates bench after enough trials, freeing slots and creating the absence runs their baseline needs.

  New validation module: `simulateGate()` and `gateOperatingCharacteristics()` drive the real store/ledger/retriever/gate pipeline with synthetic lessons of known effect — deterministic, sub-second — so any policy's detection and false-positive rates can be measured before trusting it (runnable example: `packages/evals/examples/gate-operating-characteristics/`). New dependency-free statistics utilities exported: `studentTCdf`, `welchLift`, `benjaminiHochberg`, `normalQuantile`, `requiredTrials`, `mulberry32`, `gaussian`.

### Patch Changes

- 2967433: Runner modularization, memory/persistence hardening, and dependency bumps.

  **@cycgraph/orchestrator**

  - Break up the monolithic `graph-runner.ts` into focused modules: `budget-monitor`, `executor-context-builder`, `fallback-tool-resolver`, `idempotency-tracker`, `memory-differ`, `persistence-coordinator`, `recover`, `router`, and `stream-channel`. Public API unchanged.
  - Add MCP `tool-circuit-breaker` and typed MCP error classes.
  - Add `runtime-config` module and expanded reducer + validation coverage.
  - Bump `@ai-sdk/anthropic` and OpenTelemetry packages.

  **@cycgraph/orchestrator-postgres**

  - Add retry helper around Drizzle persistence and event-log writes with covering tests.
  - Tighten event-log and persistence error handling.

  **@cycgraph/memory**

  - Improve `InMemoryMemoryIndex` (filtering, scoring) and adaptive memory compression with new test coverage.

## 0.1.0-beta.6

### Minor Changes

- 40787be: Statistically honest retention gate + validation simulator. The eval-gating gate's new default `decision_rule: 'inference'` replaces the point-estimate margin comparison with a Welch-style test on the lift vs the leave-one-out baseline (Student-t, Welch–Satterthwaite df), Benjamini–Hochberg FDR control across candidates per pass, and alpha-spending over doubling baseline brackets so repeated gating cannot inflate false positives (the peeking problem — measured at 25% false decisions before this control, 0–2% after). The legacy behavior remains one flag away (`decision_rule: 'margin'`).

  New `RetentionPolicy` fields: `promote_confidence` / `evict_confidence` (default 0.9), `noise_floor_sd`, `multiple_comparison` (`'bh'`|`'none'`), `sequential_control` (`'doubling'`|`'none'`), and `max_baseline_runs` — the baseline-side stopping rule that retires candidates the bracket penalty has made undecidable (required alongside `rest_after_trials`, which freezes trials so `max_trials` alone can never fire). `RetentionReport` entries now carry an `evidence` object (`lift`, `se`, `df`, `p_promote`, `p_evict`, `trials`, `baseline_runs`, `alpha_bracket`); `promoted` entries changed from `string[]` to `{ fact_id, evidence? }[]`. `FactStats`/`OutcomeBaseline` gain `variance` (breaking for third-party `OutcomeLedger` implementers). `retrieveGatedLessons` gains `rest_after_trials` — candidates bench after enough trials, freeing slots and creating the absence runs their baseline needs.

  New validation module: `simulateGate()` and `gateOperatingCharacteristics()` drive the real store/ledger/retriever/gate pipeline with synthetic lessons of known effect — deterministic, sub-second — so any policy's detection and false-positive rates can be measured before trusting it (runnable example: `packages/evals/examples/gate-operating-characteristics/`). New dependency-free statistics utilities exported: `studentTCdf`, `welchLift`, `benjaminiHochberg`, `normalQuantile`, `requiredTrials`, `mulberry32`, `gaussian`.

## 0.1.0-beta.5

### Minor Changes

- 8f211cc: Eval-gated learning ("verified lessons"): lessons are now retained only if runs that used them verifiably score better.

  **@cycgraph/orchestrator — lesson provenance.** Retrieved memory facts can carry an `id` (`MemoryRetrievalResult.facts[].id`, optional and non-breaking). When present, the runner records which facts were injected into each node's prompt in an append-only `memory._lesson_provenance` registry (same replay-safe pattern as the taint registry; invisible to node StateViews). Voting and evolution forward provenance from every sub-agent — losing candidates count as trials too. New exports: `getInjectedFactIds(state)`, `getLessonProvenance(state)`, `getLessonProvenanceRegistry(memory)`, plus the `LessonProvenanceEntry` / `LessonProvenanceRegistry` types. Known v1 limitation: supervisor-node retrieval is not provenance-tracked.

  **@cycgraph/memory — outcome ledger, retention gate, gated retrieval.** New `OutcomeLedger` interface + `InMemoryOutcomeLedger` (`recordOutcome({ run_id, score, fact_ids })`, per-fact trial stats, leave-one-out baselines). New `evaluateRetention(store, ledger, policy)` promotes `candidate`-tagged lessons that lift outcomes past `promote_margin` (tag rewritten to `verified`), soft-evicts harmful ones (`invalidated_by: 'eval-gate:harmful'`), and retires no-lift candidates at `max_trials` — including ones deadlocked on an empty leave-one-out baseline. New `retrieveGatedLessons(store, options)` fills the prompt budget verified-first with candidate exploration slots, selected in-progress-first via the ledger, with a `rest_after_trials` bench phase so fully-trialled candidates create the absence runs their baseline needs.

  Runnable adversarial demo at `packages/evals/examples/eval-gated-learning/`: three deliberately poisoned lessons crater a run and the gate evicts all three on outcome evidence alone, two runs after injection.

## 0.1.0-beta.4

### Minor Changes

- 131e3d3: Performance & scale (Phase 5): cut the cost of the hot paths and add the knobs to keep a long/large run bounded.

  **Tag-filtered fact retrieval is now an index lookup, not a table scan.** `FactFilter` gained a `tags` field; the hierarchical retriever pushes the reflection-loop's tag filter into the store instead of paging the whole table and filtering client-side. The Postgres store resolves it via `tags ?| array[...]` backed by a new GIN index on `memory_facts.tags` (migration `0015`) and now applies a deterministic `ORDER BY valid_from DESC, id` so `LIMIT/OFFSET` pagination is stable. The in-memory store honors the same `tags` filter (insertion-ordered, already stable). **Run `0015_add_memory_facts_tags_gin` before relying on tag retrieval at scale** — on a large live table prefer `CREATE INDEX CONCURRENTLY` out-of-band.

  **Evolution scores candidates in parallel** (bounded by the existing `max_concurrency`) instead of one evaluator call at a time — a generation now takes ~one evaluation's wall-clock, not N. It also stores per-candidate fitness **summaries** in `${node}_population` (index/fitness/reasoning) rather than every candidate's full output (the winner's full output already lives in `${node}_winner`), shrinking state and every checkpoint.

  **Memory retrieval is bounded and batched.** `extractSubgraph` gained a `max_entities` cap (default `DEFAULT_MAX_SUBGRAPH_ENTITIES = 500`) so a dense graph can't expand the BFS frontier near-exponentially, and it batch-fetches visited entities (`getEntities`) instead of one round-trip each.

  **Sanitize-after-truncate in prompt building.** Injection-sanitization is now the **last** transformation before memory/retrieved-memory is embedded — applied to exactly the bytes that reach the prompt (and to compressor output, which is now also byte-capped). Closes the window where truncating after sanitizing could leave a partial boundary artifact, and stops wasting sanitization on bytes that get dropped.

  **Delta tracker no longer loses patches on a failed persist.** `computeDelta` advances its baseline optimistically but stashes the prior baseline; the persistence coordinator calls the new `rollback()` if the write throws, so the next delta diffs against the last _durably persisted_ state (no lost changes, no skipped version numbers).

  **Auto-compaction is on by default.** `GraphRunnerOptions.compaction_interval` now defaults to `DEFAULT_COMPACTION_INTERVAL = 1000` (was `0`/disabled) when an `eventLog` is wired, so a long run can't grow the event log without bound. Compaction is recovery-safe (checkpoint + `loadEventsAfter`). Set `compaction_interval: 0` to retain full history and compact manually. The snapshot-resume idempotency rebuild is now checkpoint-aware — it loads only the tail after the latest checkpoint instead of the entire event history.

  **New `RateLimiter` port.** Inject `GraphRunnerOptions.rateLimiter` to pace LLM calls inside a provider's budget — awaited before every agent/supervisor/evaluator call at a single chokepoint (the implementation may delay to throttle or throw to reject; abortable; propagated into subgraphs). New exports: `RateLimiter`, `RateLimitRequest`, `RateLimitCallKind`.

  **Per-server MCP concurrency limit.** `MCPConnectionManager` accepts `default_max_concurrent_calls`, and `MCPServerEntry` gained `max_concurrent_calls`, bounding in-flight tool calls per server (via a FIFO semaphore) so a wide fan-out can't overwhelm one MCP server. Defaults to unlimited for compatibility.

## 0.1.0-beta.3

### Minor Changes

- d3641f2: Compound learning: `reflection` node type + `MemoryWriter` + tag-based retrieval.

  **@cycgraph/orchestrator**

  - New `reflection` node type that distills `source_keys` from workflow memory into atomic facts and persists them via an injected `MemoryWriter`. Two extractor variants:
    - `rule_based` — deterministic sentence-level extraction, no LLM call
    - `llm` — uses the new `extractFactsExecutor` primitive via a structured-output agent
  - New `MemoryWriter` adapter type on `GraphRunnerOptions` (mirrors `MemoryRetriever`).
  - New `extractFactsExecutor` primitive (sibling to `evaluateQualityExecutor`) for LLM-based fact distillation.
  - New `memory_query` directive on `GraphNode` — declares per-node retrieval (text / entity_ids / tags / max_facts). When set, the runner calls `memoryRetriever` before agent / supervisor prompt construction and renders results into a `## Relevant Memory` section ahead of the workflow-state `<data>` block. Voting and evolution nodes propagate `memory_query` to synthetic sub-nodes automatically.
  - `MemoryRetriever` query type gained `tags?: string[]`.
  - New errors: `MemoryWriterMissingError` (barrel-exported).
  - New types barrel-exported: `MemoryWriter`, `MemoryWriterFact`, `MemoryWriterResult`, `FactExtractionResult`, `ReflectionConfig`, `MemoryQuery`.

  **@cycgraph/memory**

  - `SemanticFact.tags` and `MemoryQuery.tags` fields (both default `[]`).
  - New tag-only retrieval path in `retrieveMemory()` — list facts by tag, intersect tags, apply temporal validity, expand to themes and episodes. No embedding provider required.
  - Existing embedding and entity-based paths now also intersect with the `tags` filter.

  **@cycgraph/orchestrator-postgres**

  - New `memory_facts.tags` `jsonb` column (migration `0013_add_fact_tags`).
  - `DrizzleMemoryStore` and `DrizzleMemoryIndex` row mappers updated to read/write `tags`.

## 0.1.0-beta.2

### Patch Changes

- 2967433: Runner modularization, memory/persistence hardening, and dependency bumps.

  **@cycgraph/orchestrator**

  - Break up the monolithic `graph-runner.ts` into focused modules: `budget-monitor`, `executor-context-builder`, `fallback-tool-resolver`, `idempotency-tracker`, `memory-differ`, `persistence-coordinator`, `recover`, `router`, and `stream-channel`. Public API unchanged.
  - Add MCP `tool-circuit-breaker` and typed MCP error classes.
  - Add `runtime-config` module and expanded reducer + validation coverage.
  - Bump `@ai-sdk/anthropic` and OpenTelemetry packages.

  **@cycgraph/orchestrator-postgres**

  - Add retry helper around Drizzle persistence and event-log writes with covering tests.
  - Tighten event-log and persistence error handling.

  **@cycgraph/memory**

  - Improve `InMemoryMemoryIndex` (filtering, scoring) and adaptive memory compression with new test coverage.
