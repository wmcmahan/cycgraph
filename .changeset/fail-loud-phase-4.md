---
"@cycgraph/orchestrator": minor
---

Fail-loud / operational readiness (Phase 4): surface misconfigurations and dead-ends instead of silently producing wrong results.

**Agent-not-found fails closed (BREAKING).** A typo'd or deleted `agent_id` against a configured registry previously fell back to a generic deny-all agent — the workflow ran to "completed" with garbage output and real token spend, no error. `loadAgent` now throws `AgentNotFoundError` for a configured-but-missing agent. The no-registry "lightweight dev" mode still falls back (it warns on every call). Opt back into the old behavior with `configureAgentFactory(registry, { allowDefaultFallback: true })` (tests/dev only).

**Pre-flight wiring checks.** Before any node runs, the runner now validates that the injected dependencies match the graph: a `reflection` node requires `memoryWriter`, and a node declaring MCP tool sources requires `toolResolver` — both fail the run immediately with a clear message instead of mid-run after upstream nodes already spent tokens (and, for reflection, being pointlessly retried). A node with `memory_query` but no `memoryRetriever` logs a warning.

**Routing dead-ends fail loud.** A node that is not a declared end node yet has no matching outgoing edge (e.g. a typo'd filtrex condition that evaluates false) previously dispatched `_complete` — a "successful" run that executed only part of the graph. It now fails with the new `NoMatchingEdgeError`. Set `GraphRunnerOptions.allow_implicit_completion = true` for the legacy silent-completion behavior.

**Retriable-vs-permanent error classification.** The agent executor now reads the Vercel AI SDK's `APICallError.isRetryable` and tags `AgentExecutionError.retryable`. The retry loop short-circuits a definitively non-retryable error (400 invalid-request, context-length-exceeded, 401/403/404) instead of re-issuing it `max_retries` times. The supervisor's `generateText` call is wrapped in the same typed handling (previously propagated raw).

**Observability: run_id on logs + workflow.run span.** `run()` now executes inside `runWithContext({ run_id, graph_id })` and the per-node chokepoint re-establishes it, so every downstream log line (agent executor, MCP, provider, persistence) carries `run_id`/`graph_id` for correlation — including under `stream()`. A `workflow.run` root span wraps the run, and `node.execute.{type}` spans now fire on both the streaming and non-streaming paths (the streaming path previously had none).

New exports: `NoMatchingEdgeError`, `GraphRunnerOptions.allow_implicit_completion`, `configureAgentFactory(registry, { allowDefaultFallback })`.
