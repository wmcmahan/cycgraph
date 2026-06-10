# @cycgraph/orchestrator

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
