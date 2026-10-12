# Product

Keelwise reads this as the maintainers' statement of what this product is for. It weighs every larger change it proposes against it, and never proposes one that crosses a non-goal. Keelwise drafted it at onboarding from the docs, the changelog, and recent history, citing the files behind each point. Correct anything here; Direction especially is yours to set.

## Purpose

cycgraph is for TypeScript and Node developers who build LLM agent workflows. They declare workflows as cyclic graphs (`agent`/`node`/`graph`/`run`) and get built-in patterns such as Reflection, Supervisor, Swarm, Map-Reduce, Human-in-the-Loop, Verifier and Voting. Optional add-ons provide memory, prompt compression, Postgres durability, tools, evals, a studio dashboard and A2A interop. The aim is workflows that are composable, portable, connectable across systems, observable, and self-improving by distilling lessons from each run into memory.

## Promises

What users rely on this product to do.

- Ships ready-made workflow patterns: Reflection, Evolution, Supervisor, Swarm, Map-Reduce, Self-Annealing, Human-in-the-Loop, Verifier, Voting and Subgraph. (`README.md`)
- Zero-trust state slicing: an agent's writes outside its declared `write_keys` are rejected, `status` and control flow need explicit grants, and unknown action types are denied by default. (`README.md`, `packages/orchestrator/src/state/reducers.ts`)
- Deterministic replay: state changes only through pure reducers that take time from action metadata, and event logs are stamped with `REPLAY_VERSION`. (`README.md`, `packages/orchestrator/src/state/reducers.ts`)
- Bounded memory: oversized or non-serializable values are diverted to `memory_drops` instead of entering workflow state. (`SECURITY.md`, `packages/orchestrator/src/state/reducers.ts`)
- Optional per-node and per-run token and cost budgets, enforced between model steps as well as at node boundaries. (`README.md`, `packages/orchestrator/CHANGELOG.md`)
- Web and A2A access is SSRF-guarded: private hosts are blocked and every redirect is revalidated manually, up to 5 hops. (`packages/tools/README.md`, `packages/tools/src/web/ssrf.ts`, `packages/a2a/src/connection.ts`)
- Safety controls beyond permissions: taint tracking, fact sanitization, eval-gated memory retention, human-in-the-loop resume, and an MCP registry allowlist. (`README.md`)
- Self-improving runs: each run distills lessons into memory, and later runs retrieve them automatically. (`packages/orchestrator/package.json`, `README.md`)
- Postgres durability with pgvector, an event log, a queue, and row-level-security tenant isolation enforced by a dedicated CI gate. (`packages/orchestrator-postgres/README.md`, `.github/workflows/ci.yml`)
- The studio debugs, improves and monitors runs but never pushes to git. (`packages/studio/README.md`)

## Non-goals

What this product deliberately does not do.

- No defence against a malicious operator with write access to the agents registry, the MCP registry or the database (SECURITY.md).
- No defence against vulnerabilities in third-party MCP servers (SECURITY.md).
- Architect-generated graphs are never auto-executed (SECURITY.md).
- Jailbreaks that stay within declared permissions are treated as an alignment concern, not an engine bug (SECURITY.md).

## Direction

Where the product is heading now. Keelwise drafted these from the repository's stated plans; keep the ones the maintainers mean.

- Opening up model providers: an OpenAI-compatible catalog, Google, and effort levels. (`packages/orchestrator/CHANGELOG.md`)
- Hardening Agent2Agent interop across releases: retries, timeouts, SSRF pinning and settle behaviour. (`packages/a2a/CHANGELOG.md`)
- The studio improve/tune ladder and self-improving maintenance workflows. (`ops/maintenance/README.md`, `packages/studio/README.md`)

## Constraints

Limits every change must respect.

- Node >=22, declared in every package.json `engines`; CI tests Node 22 as the floor.
- ESM only: every package sets `"type": "module"`.
- zod ^4 is a peer dependency.
- Durability requires Postgres with the pgvector extension (pg16 in CI).
- TypeScript is pinned to 7.0.2 in every package.
- Security fixes are backported to the latest minor line only (SECURITY.md).
- Reducer behaviour changes must bump `REPLAY_VERSION` so recorded event logs stay replayable.
