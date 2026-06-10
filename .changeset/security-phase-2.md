---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
---

Security hardening (Phase 2): close the gaps between the documented security model and what the code enforced.

**Architect publish is validated and gateable.** `architect_publish_workflow` now runs `GraphSchema.parse` + `validateGraph` before persisting — a prompt-injected or buggy agent can no longer publish an unvalidated executable graph (wildcard reads, unbounded fan-out, arbitrary tool wiring). New optional `ArchitectToolDeps.canPublish` gate lets the host require human approval / a privileged credential before any publish.

**MCP registry is re-validated at the trust boundary + SSRF guard.** Both `InMemoryMCPServerRegistry` and `DrizzleMCPServerRegistry` now `MCPServerEntrySchema.parse` on save AND load — the stdio command allowlist and URL checks are enforced for real, not just at compile time, closing a host-RCE path. Transport URLs (http/sse) are blocked from pointing at private / loopback / link-local / cloud-metadata addresses (SSRF). Escape hatch for local dev: `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true`.

**Taint tracking holes fixed.** (1) Standalone `tool` nodes now taint their MCP output — previously external data was written to memory untainted, defeating taint-aware routing. (2) Concurrent executions (voting/evolution/map) no longer cross-attribute taint: each `resolveTools()` gets its own collector, drained via `drainTaintEntries(tools)`. (3) `_taint_registry` is now append-only through reducers — a crafted `update_memory: { _taint_registry: {} }` can no longer clear taint to launder untrusted data as trusted.

**`read_keys` defaults to least privilege (BREAKING).** Node `read_keys` now defaults to `[]` instead of `['*']`. A node sees only `goal`/`constraints` plus the memory keys it explicitly lists — state slicing is on by default. Nodes that read upstream outputs must declare them (e.g. `read_keys: ['research_notes']`). `validateGraph` warns on any node using `['*']`. The architect prompt/schema emit explicit, scoped keys.

**Resource bounds (DoS guards).** Added upper bounds to every fan-out/iteration knob: `population_size` ≤ 100, `max_generations` ≤ 100, `max_concurrency` ≤ 50, `voter_agent_ids` ≤ 50, supervisor/annealing `max_iterations` ≤ 1000. Subgraph nesting is capped at depth 32 (a chain of distinct subgraphs previously recursed to OOM), and subgraphs now inherit the parent's guardrails (toolResolver, factSanitizer, memoryWriter, modelResolver, etc.) instead of running with reduced guarantees.

**Reflection facts are sanitized + fail-closed.** Fact content is injection-sanitized before persistence, closing a cross-run stored-injection channel (tainted content → distilled fact → retrieved into a future run's prompt). `factSanitizer` now FAILS CLOSED by default: a thrown sanitizer (downed PII service, buggy regex) drops the fact instead of persisting it unredacted. New `GraphRunnerOptions.factSanitizerFailMode: 'drop' | 'pass'` (default `'drop'`); set `'pass'` to restore the old fail-open behavior.

New exports: `ArchitectToolDeps.canPublish`, `GraphRunnerOptions.factSanitizerFailMode`.
