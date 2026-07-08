---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
"@cycgraph/memory": minor
"@cycgraph/context-engine": minor
---

Packaging: shared libraries moved to peer dependencies, and the Node engine floor lowered to 22.

**BREAKING — install-time.** Libraries that a consumer composes against the packages' own objects are now `peerDependencies` and must be installed by the consumer:

- `zod` (`@cycgraph/orchestrator`, `@cycgraph/memory`, `@cycgraph/context-engine`) — these packages export Zod schemas that consumers parse with and compose into their own schemas.
- `ai` (`@cycgraph/orchestrator`) — the package exports `LanguageModel` types from the AI SDK.
- `drizzle-orm` (`@cycgraph/orchestrator-postgres`) — the package exports Drizzle table objects (`export * from './schema'`) that consumers query with their own Drizzle operators (`eq`, `sql`, …). Drizzle tags tables/columns with internal Symbols, so two copies at different versions break at runtime; a single shared copy is required.

Most consumers already depend on these directly, so no change is needed. A consumer that relied on them being installed transitively must now add them to its own `dependencies`.

**OpenTelemetry is now optional.** `@opentelemetry/api` remains a dependency (it no-ops without an SDK), but the heavy `@opentelemetry/sdk-node`, exporters, `sdk-metrics`, `resources`, and `semantic-conventions` are now **optional** peer dependencies. Tracing/metrics are already loaded via dynamic `import()` only when enabled, so a deployment that doesn't export telemetry no longer installs the full OTel stack. Install them to enable trace/metric export.

**Node `engines` floor lowered from `>=24` to `>=22`.** The packages run on Node 22 LTS (the whole test suite runs on it), so this only widens compatibility — Node 22 consumers no longer get `EBADENGINE` warnings.
