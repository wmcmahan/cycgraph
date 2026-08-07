---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": patch
---

Run-scoped agent factory: the agent registry and provider registry can now be scoped into a run via `GraphRunnerOptions`, removing the process-global multi-tenant footgun.

- New `GraphRunnerOptions.registry` and `GraphRunnerOptions.providers`. When either is set, the runner builds a run-scoped agent factory, so two concurrent runs with different registries (even reusing an agent id) never contaminate each other. Without them, the runner falls back to the process-global factory (unchanged behavior). When only one is set, the other half is inherited from the global factory, so scoping providers alone doesn't drop a globally-configured registry. A scoped factory always fails closed on unknown agent ids.
- Subgraph child runners inherit the parent's scoped `registry`/`providers` and its `tools` option, so a scoped run stays scoped through nested graphs (and subgraph agents keep their tool resolution).
- The authoring facade's `run()` now uses the scoped path — no process-global mutation — so concurrent facade runs are isolated by construction.
- `configureAgentFactory` and `configureProviderRegistry` are **deprecated** (still functional). They mutate process-global state shared across every run in the process. Prefer scoping via `GraphRunnerOptions`. They will be removed once consumers have migrated.
- The agent factory no longer rejects non-UUID agent ids up front; the registry owns id-shape constraints. The Postgres adapter treats a non-UUID id as clean not-found across the board (the `agents.id` column is `uuid`): `loadAgent` returns `null`, `updateAgent` no-ops, and `deleteAgent` returns `false`, instead of surfacing a Postgres type error. This lets human-readable ids (e.g. from the authoring facade) resolve against an in-memory registry.

**Migration (mc-ai-api and other consumers):** replace startup `configureAgentFactory(registry)` / `configureProviderRegistry(providers)` with per-run options: `new GraphRunner(graph, state, { registry, providers, ... })` (or, for the worker, add them to the `runnerOptionsFactory` result). The global helpers keep working during the transition, so this can be done incrementally. Scoping per run is what makes a multi-tenant worker safe — a process-global factory shared across tenants is the contamination risk this change removes.
