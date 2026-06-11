# @cycgraph/orchestrator

## 0.1.0-beta.7

### Patch Changes

- 5617568: Upgrade OpenTelemetry to the current line and drop the `protobufjs` override (resolves a moderate advisory).

  The OTLP-HTTP and Prometheus exporters were on `0.217.0` and pulled `protobufjs@8.0.x` transitively (via `@opentelemetry/otlp-transformer`). A repo-wide `protobufjs: ">=8.0.1"` override pinned it to `8.0.3` — which is inside the vulnerable range of GHSA-jggg-4jg4-v7c6 (DoS via recursive JSON descriptor expansion, `>=8.0.0 <8.2.0`).

  `@opentelemetry/otlp-transformer@0.219.0` no longer depends on `protobufjs` at all, so bumping the exporters removes that dependency edge. The only remaining `protobufjs` is `7.6.3` via `@grpc/proto-loader` (the gRPC log exporter bundled in `sdk-node`), which is outside the advisory range. With the override removed, `npm audit --omit=dev` reports 0 vulnerabilities.

  Bumped: `@opentelemetry/exporter-prometheus`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-node` `^0.217.0` → `^0.219.0`; `@opentelemetry/resources`, `@opentelemetry/sdk-metrics` `^2.7.1` → `^2.8.0`. Removed the `protobufjs` entry from the root `overrides`.

## 0.1.0-beta.6

### Minor Changes

- 027be81: Fix: `evolution_config.elite_count` is now actually implemented (it was a no-op).

  The schema and validator advertised `elite_count` and rejected `elite_count >= population_size`, but the executor never used it — every generation was bred entirely from scratch, so the per-generation best fitness could dip when a noisy generation produced worse candidates than the last.

  Elitism now works as documented: the top `elite_count` candidates of each generation are carried forward **unchanged** into the next generation's pool — not re-generated and not re-scored. Two consequences:

  - **Monotonic fitness.** The best-so-far re-enters every subsequent pool, so the next generation's best is always ≥ the current one. `${node}_fitness_history` never dips. (Set `elite_count: 0` to opt out and restore the old all-fresh behavior.)
  - **Fewer LLM calls.** A carried elite occupies a population slot without a generation or evaluation call, so each generation after the first issues `population_size - elite_count` candidate calls instead of `population_size`.

  `elite_count` defaults to `1`, so this changes default evolution behavior. The carried candidate is tagged `is_elite: true` in the `${node}_population` summary. `elite_count` is internally clamped to `population_size - 1` so at least one fresh candidate is always generated.

## 0.1.0-beta.5

### Minor Changes

- 131e3d3: Architecture & API hygiene (Phase 6): tighten the public surface and close a status-resurrection hole.

  **Status-transition guard (correctness).** A shared guard now governs every status write (both the public `set_status` reducer and the internal lifecycle reducer). A run that has reached a terminal state (`completed`, `failed`, `cancelled`, `timeout`) can no longer be moved back to an active status — previously a stray `set_status`, or a replayed `_init` on a recovered run, could flip `failed` → `running` and resurrect a dead run. Terminal→terminal transitions remain allowed for saga rollback (`failed`/`timeout` → `cancelled`). New exports: `canTransitionStatus`, `isTerminalStatus`, `TERMINAL_STATUSES`.

  **Node-type executor registry.** The 12-case dispatch `switch` in `GraphRunner` is replaced by a `Record<NodeType, NodeExecutor>` registry (`runner/node-executors/registry.ts`). Adding a node type is now a single registration that the compiler enforces is exhaustive, instead of shotgun edits across the runner. New exports: `NODE_EXECUTORS`, `SUPPORTED_NODE_TYPES`, `getNodeExecutor`, and the `NodeExecutor` type.

  **Public API hygiene (BREAKING).** Engine internals that were leaking through the root entry point are moved behind a new `@cycgraph/orchestrator/internal` subpath: `internalReducer`, `StreamChannel`, the filtrex condition internals (`FILTREX_EXTRA_FUNCTIONS`, `FILTREX_COMPILE_OPTIONS`, `normalizeConditionExpression`), and the low-level `calculateBackoff` / `sleep` helpers. They are no longer part of the semver contract — import them from `@cycgraph/orchestrator/internal` if you genuinely need them (first-party tooling only). The public condition evaluator `evaluateCondition` stays on the root. Wildcard `export *` of the reducers/helpers/conditions barrels is replaced with explicit named exports so the public surface is auditable.

  **Dropped the phantom `@cycgraph/context-engine` peerDependency.** The orchestrator integrates the context engine purely via an injected function type (`ContextCompressor`) and never imports the package, so the (optional) peer dependency was noise. Removed.

- 131e3d3: Budget integrity (Phase 3): make every LLM call count toward budgets and stop runaway spend mid-loop.

  **Supervisor spend is now tracked.** Supervisor routing calls previously recorded NO `token_usage` on their handoff/completion actions, so every iteration's tokens were invisible to the token budget, cost budget, per-node budget, and usage records — on a 10-iteration loop that hid 100K–1M+ tokens. Handoff and completion actions now carry `token_usage` + `model`, so supervisor spend flows through the normal `_track_tokens`/`_track_cost` path.

  **Supervisor prompt memory is byte-capped.** The supervisor prompt embedded the full memory blob with no size limit, so a loop that re-reads memory every iteration grew ~quadratically. It now uses the same `MAX_MEMORY_PROMPT_BYTES` (50KB) cap as agent prompts.

  **Composite nodes stop spending mid-loop.** Per-node and workflow budgets were only checked AFTER a composite node's aggregated action returned — an evolution node ran its entire population × generations before the cap was even consulted. A new between-iteration budget guard (`checkCompositeBudget`) lets evolution and annealing stop early once accumulated token/cost spend crosses the node's `budget` or the remaining workflow budget. Evolution surfaces a `{nodeId}_budget_stopped` flag.

  **Failed-attempt LLM spend is counted.** A node that retries N times previously counted only the successful attempt's tokens. The agent executor now attaches best-effort `partialUsage` to `AgentExecutionError`/`AgentTimeoutError`, and the runner dispatches `_track_tokens`/`_track_cost` for each failed attempt — so a `max_retries: 3` node can no longer hide up to ~4× its visible spend.

  **Parallel task timeouts actually abort the LLM call.** Evolution/voting/map passed `executeParallel` a per-task timeout signal that the callers ignored, wiring only the workflow signal — so a `task_timeout_ms` left the underlying `streamText` running in the background, burning uncounted tokens. The callers now combine both signals (`combineAbortSignals`), so a task timeout cancels the LLM call.

- 131e3d3: Durability hardening (Phase 1): make crash recovery, idempotency, and multi-worker execution actually safe.

  **Deterministic replay.** Reducers now derive every timestamp (`started_at`, `updated_at`, approval deadlines, history entries) from `action.metadata.timestamp` instead of `new Date()`, so event-log replay reconstructs byte-identical state. `applyHumanResponse` logs its `resume_from_human` action durably (resumed runs previously lost the human decision). `workflow_started` carries a `REPLAY_VERSION` stamp recovery checks for reducer-semantics drift.

  **State hydration.** New `hydrateWorkflowState()` (barrel-exported) runs at every load boundary — coerces jsonb date strings back to `Date`, applies `state_schema_version` migrations, and refuses snapshots from a newer engine. Fixes the bug where a recovered HITL workflow compared `new Date() >= waiting_timeout_at` against a _string_ (always false), so approval timeouts never fired after recovery.

  **Authoritative event log.** Appends are awaited behind a flush barrier before each state snapshot commits (events can no longer silently lag the snapshot they anchor). Duplicate `(run_id, sequence_id)` appends are rejected with the new `EventSequenceConflictError` instead of being silently dropped (Postgres) or duplicated (in-memory) — the two implementations now match. Recovery validates the log is gap-free (`EventLogCorruptionError` on a lost append) and the worker reconciles event-log replay against the latest snapshot, resuming from whichever reflects more progress.

  **Unified idempotency.** One key space (`node_id:iteration`) checked before execution; a node whose action was applied before a crash (post-reduce/pre-advance window, detected via the snapshot's new `_last_event_sequence_id` high-water mark) is skipped on resume instead of re-executed. `MemoryWriter` now receives an `idempotency_key` (`run_id:node_id:iteration`) so reflection facts stop duplicating in long-term memory on retry/recovery.

  **Durable queue + run fencing.** New `DrizzleWorkflowQueue` (migration `0014`, `workflow_jobs` table) with `FOR UPDATE SKIP LOCKED` atomic claims. Every claim bumps a `claim_epoch` on the run; `createFencedRunnerOptions(job)` builds fenced persistence/event-log writers that reject stale-epoch writes with the new `StaleClaimError` — a reclaimed worker can no longer clobber the new claimant (split-brain). The worker emits `job:claim_lost` and leaves the job untouched. `worker.stop()` now hard-cancels runners past the grace period before releasing jobs, and shutdown-interrupted jobs stay `active` for visibility-timeout reclaim. `InMemoryWorkflowQueue` mirrors the epoch semantics for parity.

  New barrel exports: `hydrateWorkflowState`, `CURRENT_STATE_SCHEMA_VERSION`, `REPLAY_VERSION`, `EventSequenceConflictError`, `StaleClaimError`. New Postgres exports: `DrizzleWorkflowQueue`, `createFencedRunnerOptions`, `DrizzlePersistenceProviderOptions`, `RunClaim`, `DrizzleEventLogWriterOptions`.

- 131e3d3: Fail-loud / operational readiness (Phase 4): surface misconfigurations and dead-ends instead of silently producing wrong results.

  **Agent-not-found fails closed (BREAKING).** A typo'd or deleted `agent_id` against a configured registry previously fell back to a generic deny-all agent — the workflow ran to "completed" with garbage output and real token spend, no error. `loadAgent` now throws `AgentNotFoundError` for a configured-but-missing agent. The no-registry "lightweight dev" mode still falls back (it warns on every call). Opt back into the old behavior with `configureAgentFactory(registry, { allowDefaultFallback: true })` (tests/dev only).

  **Pre-flight wiring checks.** Before any node runs, the runner now validates that the injected dependencies match the graph: a `reflection` node requires `memoryWriter`, and a node declaring MCP tool sources requires `toolResolver` — both fail the run immediately with a clear message instead of mid-run after upstream nodes already spent tokens (and, for reflection, being pointlessly retried). A node with `memory_query` but no `memoryRetriever` logs a warning.

  **Routing dead-ends fail loud.** A node that is not a declared end node yet has no matching outgoing edge (e.g. a typo'd filtrex condition that evaluates false) previously dispatched `_complete` — a "successful" run that executed only part of the graph. It now fails with the new `NoMatchingEdgeError`. Set `GraphRunnerOptions.allow_implicit_completion = true` for the legacy silent-completion behavior.

  **Retriable-vs-permanent error classification.** The agent executor now reads the Vercel AI SDK's `APICallError.isRetryable` and tags `AgentExecutionError.retryable`. The retry loop short-circuits a definitively non-retryable error (400 invalid-request, context-length-exceeded, 401/403/404) instead of re-issuing it `max_retries` times. The supervisor's `generateText` call is wrapped in the same typed handling (previously propagated raw).

  **Observability: run_id on logs + workflow.run span.** `run()` now executes inside `runWithContext({ run_id, graph_id })` and the per-node chokepoint re-establishes it, so every downstream log line (agent executor, MCP, provider, persistence) carries `run_id`/`graph_id` for correlation — including under `stream()`. A `workflow.run` root span wraps the run, and `node.execute.{type}` spans now fire on both the streaming and non-streaming paths (the streaming path previously had none).

  New exports: `NoMatchingEdgeError`, `GraphRunnerOptions.allow_implicit_completion`, `configureAgentFactory(registry, { allowDefaultFallback })`.

- 131e3d3: Performance & scale (Phase 5): cut the cost of the hot paths and add the knobs to keep a long/large run bounded.

  **Tag-filtered fact retrieval is now an index lookup, not a table scan.** `FactFilter` gained a `tags` field; the hierarchical retriever pushes the reflection-loop's tag filter into the store instead of paging the whole table and filtering client-side. The Postgres store resolves it via `tags ?| array[...]` backed by a new GIN index on `memory_facts.tags` (migration `0015`) and now applies a deterministic `ORDER BY valid_from DESC, id` so `LIMIT/OFFSET` pagination is stable. The in-memory store honors the same `tags` filter (insertion-ordered, already stable). **Run `0015_add_memory_facts_tags_gin` before relying on tag retrieval at scale** — on a large live table prefer `CREATE INDEX CONCURRENTLY` out-of-band.

  **Evolution scores candidates in parallel** (bounded by the existing `max_concurrency`) instead of one evaluator call at a time — a generation now takes ~one evaluation's wall-clock, not N. It also stores per-candidate fitness **summaries** in `${node}_population` (index/fitness/reasoning) rather than every candidate's full output (the winner's full output already lives in `${node}_winner`), shrinking state and every checkpoint.

  **Memory retrieval is bounded and batched.** `extractSubgraph` gained a `max_entities` cap (default `DEFAULT_MAX_SUBGRAPH_ENTITIES = 500`) so a dense graph can't expand the BFS frontier near-exponentially, and it batch-fetches visited entities (`getEntities`) instead of one round-trip each.

  **Sanitize-after-truncate in prompt building.** Injection-sanitization is now the **last** transformation before memory/retrieved-memory is embedded — applied to exactly the bytes that reach the prompt (and to compressor output, which is now also byte-capped). Closes the window where truncating after sanitizing could leave a partial boundary artifact, and stops wasting sanitization on bytes that get dropped.

  **Delta tracker no longer loses patches on a failed persist.** `computeDelta` advances its baseline optimistically but stashes the prior baseline; the persistence coordinator calls the new `rollback()` if the write throws, so the next delta diffs against the last _durably persisted_ state (no lost changes, no skipped version numbers).

  **Auto-compaction is on by default.** `GraphRunnerOptions.compaction_interval` now defaults to `DEFAULT_COMPACTION_INTERVAL = 1000` (was `0`/disabled) when an `eventLog` is wired, so a long run can't grow the event log without bound. Compaction is recovery-safe (checkpoint + `loadEventsAfter`). Set `compaction_interval: 0` to retain full history and compact manually. The snapshot-resume idempotency rebuild is now checkpoint-aware — it loads only the tail after the latest checkpoint instead of the entire event history.

  **New `RateLimiter` port.** Inject `GraphRunnerOptions.rateLimiter` to pace LLM calls inside a provider's budget — awaited before every agent/supervisor/evaluator call at a single chokepoint (the implementation may delay to throttle or throw to reject; abortable; propagated into subgraphs). New exports: `RateLimiter`, `RateLimitRequest`, `RateLimitCallKind`.

  **Per-server MCP concurrency limit.** `MCPConnectionManager` accepts `default_max_concurrent_calls`, and `MCPServerEntry` gained `max_concurrent_calls`, bounding in-flight tool calls per server (via a FIFO semaphore) so a wide fan-out can't overwhelm one MCP server. Defaults to unlimited for compatibility.

- 131e3d3: Security hardening (Phase 2): close the gaps between the documented security model and what the code enforced.

  **Architect publish is validated and gateable.** `architect_publish_workflow` now runs `GraphSchema.parse` + `validateGraph` before persisting — a prompt-injected or buggy agent can no longer publish an unvalidated executable graph (wildcard reads, unbounded fan-out, arbitrary tool wiring). New optional `ArchitectToolDeps.canPublish` gate lets the host require human approval / a privileged credential before any publish.

  **MCP registry is re-validated at the trust boundary + SSRF guard.** Both `InMemoryMCPServerRegistry` and `DrizzleMCPServerRegistry` now `MCPServerEntrySchema.parse` on save AND load — the stdio command allowlist and URL checks are enforced for real, not just at compile time, closing a host-RCE path. Transport URLs (http/sse) are blocked from pointing at private / loopback / link-local / cloud-metadata addresses (SSRF). Escape hatch for local dev: `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true`.

  **Taint tracking holes fixed.** (1) Standalone `tool` nodes now taint their MCP output — previously external data was written to memory untainted, defeating taint-aware routing. (2) Concurrent executions (voting/evolution/map) no longer cross-attribute taint: each `resolveTools()` gets its own collector, drained via `drainTaintEntries(tools)`. (3) `_taint_registry` is now append-only through reducers — a crafted `update_memory: { _taint_registry: {} }` can no longer clear taint to launder untrusted data as trusted.

  **`read_keys` defaults to least privilege (BREAKING).** Node `read_keys` now defaults to `[]` instead of `['*']`. A node sees only `goal`/`constraints` plus the memory keys it explicitly lists — state slicing is on by default. Nodes that read upstream outputs must declare them (e.g. `read_keys: ['research_notes']`). `validateGraph` warns on any node using `['*']`. The architect prompt/schema emit explicit, scoped keys.

  **Resource bounds (DoS guards).** Added upper bounds to every fan-out/iteration knob: `population_size` ≤ 100, `max_generations` ≤ 100, `max_concurrency` ≤ 50, `voter_agent_ids` ≤ 50, supervisor/annealing `max_iterations` ≤ 1000. Subgraph nesting is capped at depth 32 (a chain of distinct subgraphs previously recursed to OOM), and subgraphs now inherit the parent's guardrails (toolResolver, factSanitizer, memoryWriter, modelResolver, etc.) instead of running with reduced guarantees.

  **Reflection facts are sanitized + fail-closed.** Fact content is injection-sanitized before persistence, closing a cross-run stored-injection channel (tainted content → distilled fact → retrieved into a future run's prompt). `factSanitizer` now FAILS CLOSED by default: a thrown sanitizer (downed PII service, buggy regex) drops the fact instead of persisting it unredacted. New `GraphRunnerOptions.factSanitizerFailMode: 'drop' | 'pass'` (default `'drop'`); set `'pass'` to restore the old fail-open behavior.

  New exports: `ArchitectToolDeps.canPublish`, `GraphRunnerOptions.factSanitizerFailMode`.

### Patch Changes

- 131e3d3: Test & CI hardening (Phase 7).

  **Fixed: the migration chain could never build the schema from scratch (orchestrator-postgres).** Two compounding gaps meant `npm run migrate` had never actually run end-to-end on a fresh database:

  1. A stray `drizzle` entry in `.gitignore` silently kept 14 of the 16 migration `.sql` files out of git, while `meta/_journal.json` (tracked) references all 16. Since the package publishes `drizzle/` and releases run from a clean checkout, a published build — or any CI/clone — had a journal pointing at absent files. The ignore rule now keeps `packages/orchestrator-postgres/drizzle/**`.

  2. The `@cycgraph/memory` tables (`memory_entities`, `memory_relationships`, `memory_episodes`, `memory_themes`, `memory_facts`, `memory_entity_facts`) were only ever created with `drizzle-kit push` and **never captured in a migration** — yet migration `0013` adds a column to `memory_facts` and `0015` indexes it. A from-scratch migrate therefore failed with `relation "memory_facts" does not exist`. Migration `0013` now creates the full memory schema (tables, FKs, indexes) before the `tags` ALTER, so the chain applies cleanly.

  Because the chain had never successfully applied anywhere (dev/prod used `push`), there is no migrated database for these changes to conflict with.

  **CI now runs the Postgres integration tests against a real database.** The `test-orchestrator-postgres` job gains a `pgvector/pgvector:pg16` service container, creates the `vector` extension (a `services:` container doesn't auto-run `init.sql`, and no migration creates it), applies migrations, and runs the suite **without** `--passWithNoTests`. The ~66 Drizzle adapter / durable-event-log / SKIP-LOCKED queue + fencing tests that were silently skipping now execute and must pass.

  **Coverage thresholds gate the orchestrator suite.** `vitest run --coverage` enforces a regression ratchet (global plus per-directory floors on `src/runner` and `src/agent`), scoped to `src/` so built/dist/scratch files don't skew the numbers. The CI orchestrator job runs with `--coverage` so a meaningful coverage drop fails the build.

  **New tests for previously-uncovered units:** the `verifier` node executor (all three variants — `llm_judge` / `expression` / `jsonpath` — plus assertion ops, `result_key`, and `throw_on_fail`), and a `computeMemoryDiff` apply round-trip suite.

## 0.1.0-beta.4

### Minor Changes

- 2812c0e: **Evolution: deterministic fitness via `fitnessFunction` callback + cost-tracking fixes for multi-agent executors.**

  - New `GraphRunnerOptions.fitnessFunction?: FitnessFunction` callback. When provided, the `evolution` node uses it to score each candidate deterministically instead of routing through the LLM-as-judge `evaluator_agent_id`. Useful for tasks with verifiable answers (regex, SQL, code, math) where the LLM judge's variance is larger than the discrimination required. `evaluator_agent_id` on `EvolutionConfigSchema` is now optional; one of the two must be configured or the executor throws `NodeConfigError`.
  - New `FitnessFunction` and `FitnessResult` types exported from the package barrel.
  - Evolution now propagates `parent.reasoning` to subsequent generations via the `_evolution_parent_reasoning` memory key. Previously the candidate could see the parent regex and its fitness score but not _which_ tests caused the score — meaningful refinement required guessing. With reasoning propagated, candidates can make targeted edits.
  - `EvolutionConfigSchema.fitness_threshold` upper bound (`max(1)`) removed. Setting the threshold above `1.0` (e.g. `1.5`) now disables early-fitness-exit so the loop runs all `max_generations` regardless of how good any single candidate is. Useful for instrumentation, baselining, and proof-of-iteration runs.
  - New `examples/evolution-regex/` — evolves a regex that matches HTTP 4xx status codes excluding 401, 403, and 404, with deterministic fitness scoring. Documented honestly: modern LLMs (Haiku 4.5+) one-shot well-specified regex tasks, so the example sets `fitness_threshold` above 1.0 to force all generations to execute as proof of engine mechanics. Genuine fitness climbing emerges naturally on harder domain-specific tasks the candidate model can't one-shot.

  **Bug fixes**:

  - `evolution`, `voting`, and `map` executors now surface `inputTokens` / `outputTokens` in the returned action's `metadata.token_usage`, not just `totalTokens`. The runner's cost-tracking path requires the split to call `calculateCost(model, inputTokens, outputTokens)` — without it, cost silently stayed at `$0.00` for these node types even after substantial spend.
  - `evolution`, `voting`, and `map` executors now also propagate `model` to the returned action's metadata (captured from the first successful inner agent action). Without it, the pricing lookup defaulted to an empty model string and produced `$0.00` even when the token split was present.
  - `examples/evolution/` now correctly extracts `candidate_output` from the winner's updates blob instead of stringifying the object as `[object Object]`.

## 0.1.0-beta.3

### Minor Changes

- d3641f2: Guardrails: per-node resource cap + reflection fact sanitizer.

  **Per-node `budget`** — new optional `budget: { max_tokens?, max_cost_usd? }` field on every node. Enforced after each successful execution; breaching either cap throws the new `NodeBudgetExceededError` (barrel-exported) and stops the workflow immediately. Stops a runaway annealing loop or oversized reflection extraction from eating the entire workflow budget. Independent from `state.budget_usd` / `state.max_token_budget`, which keep guarding the run as a whole.

  **`factSanitizer` on `GraphRunnerOptions`** — new optional pre-write hook applied to every fact emitted by a `reflection` node before it reaches `memoryWriter`. Returning `null` drops the fact; returning a modified fact substitutes it. Used for PII redaction, policy filtering, content moderation at the memory-write boundary. Errors thrown by the sanitizer are logged (`fact_sanitizer_failed`) and the original fact passes through — a downed PII service must not block compound learning. New type barrel-exported: `FactSanitizer`.

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
