---
"@cycgraph/orchestrator-postgres": patch
"@cycgraph/orchestrator": patch
---

Test & CI hardening (Phase 7).

**Fixed: the migration chain could never build the schema from scratch (orchestrator-postgres).** Two compounding gaps meant `npm run migrate` had never actually run end-to-end on a fresh database:

1. A stray `drizzle` entry in `.gitignore` silently kept 14 of the 16 migration `.sql` files out of git, while `meta/_journal.json` (tracked) references all 16. Since the package publishes `drizzle/` and releases run from a clean checkout, a published build — or any CI/clone — had a journal pointing at absent files. The ignore rule now keeps `packages/orchestrator-postgres/drizzle/**`.

2. The `@cycgraph/memory` tables (`memory_entities`, `memory_relationships`, `memory_episodes`, `memory_themes`, `memory_facts`, `memory_entity_facts`) were only ever created with `drizzle-kit push` and **never captured in a migration** — yet migration `0013` adds a column to `memory_facts` and `0015` indexes it. A from-scratch migrate therefore failed with `relation "memory_facts" does not exist`. Migration `0013` now creates the full memory schema (tables, FKs, indexes) before the `tags` ALTER, so the chain applies cleanly.

Because the chain had never successfully applied anywhere (dev/prod used `push`), there is no migrated database for these changes to conflict with.

**CI now runs the Postgres integration tests against a real database.** The `test-orchestrator-postgres` job gains a `pgvector/pgvector:pg16` service container, creates the `vector` extension (a `services:` container doesn't auto-run `init.sql`, and no migration creates it), applies migrations, and runs the suite **without** `--passWithNoTests`. The ~66 Drizzle adapter / durable-event-log / SKIP-LOCKED queue + fencing tests that were silently skipping now execute and must pass.

**Coverage thresholds gate the orchestrator suite.** `vitest run --coverage` enforces a regression ratchet (global plus per-directory floors on `src/runner` and `src/agent`), scoped to `src/` so built/dist/scratch files don't skew the numbers. The CI orchestrator job runs with `--coverage` so a meaningful coverage drop fails the build.

**New tests for previously-uncovered units:** the `verifier` node executor (all three variants — `llm_judge` / `expression` / `jsonpath` — plus assertion ops, `result_key`, and `throw_on_fail`), and a `computeMemoryDiff` apply round-trip suite.
