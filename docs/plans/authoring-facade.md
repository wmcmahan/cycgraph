# Authoring Facade — Design Plan

**Status**: Phase 1 implemented, then **REDESIGNED to v2 2026-08-04** before release (changesets unpublished, so not a break). Phase 2 (scoped registry) implemented. See "v2 model" below — it supersedes decisions 1 and the reads/writes-on-agent aspect of the original API design.

## v2 model (decided 2026-08-04 — supersedes parts of the original design)

Will identified that v1 conflated two concepts: an **agent** (capability) and a **node** (placement). Symptoms: `agent()` values sat in the `nodes` list (mixed intent), agents required hand-managed ids (against the registry-mints-ids principle), and agents referenced from config rather than placed as nodes (supervisor brains, evolution candidates) were inexpressible — which blocked the pattern-page docs sweep.

The corrected vocabulary is a pipeline; each word means one thing:

- **`agent(spec)`** → an inert capability value. No id (optional pin for deterministic JSON; otherwise `graph()` mints a UUID — ids are the registry's job), no grants, no topology. `name`/`description` optional (supervisors read them).
- **`node(spec)`** → an inert placement value: topology `id`, state grants (`reads`/`writes` — the NODE is the authoritative grant in the engine, so this fixes v1's grants-on-agent), `agent:` reference, `type` (defaults `'agent'` when `agent` present). The value exposes its spec properties (`research.id`) so **references go by value**: edges `{ from: research, to: write }`, `startNode`, `endNodes`, `managedNodes` all accept `string | NodeValue`. Asymmetry is deliberate: node ids are yours, so the value shows them; agent ids belong to the registry, so agent values stay opaque.
- **`graph(spec)`** → the compiler: deep-resolves branded references anywhere in node configs (AgentValue → minted registry id, collected for registration; NodeValue → its id) — generic via brand detection, so `candidateAgentId: writerAgent`, `voterAgentIds: [a, b]`, supervisor `agent:` etc. need no per-pattern facade code. Emits the same snake_case wire as `createGraph` (identical-wire test). Agent configs stashed in a WeakMap for `run()`.
- **`run(graph, input)`** → registers collected agents into a run-scoped registry and executes.

One agent value at N nodes = one registration, one id. Duplicate node ids error at compile. Implementation gotcha: object spread copies symbol keys, so the node brand must be destructured away before the deep-resolve walk (a branded `rest` would collapse to its id).
**Created**: 2026-08-04
**Scope**: `packages/orchestrator` public authoring surface. Additive Phase 1 (zero mc-ai-api impact); globals retirement deferred to Phase 2.

## Goal

Cut the ceremony required to author a workflow while keeping the graph topology fully explicit. Today the smallest real example — two agents in sequence — is ~140 lines, 9 imports, and two process-global side-effect calls. The graph is the product, so it stays visible (`nodes` + `edges`); everything *around* it that isn't flow gets derived or defaulted.

## The problem (measured against `examples/research-and-write`)

| Ceremony | Today | Why it's noise |
|---|---|---|
| Global config | `configureAgentFactory(registry)`, `createProviderRegistry()` + `configureProviderRegistry()` | Process-global singletons; unsafe under concurrency (the evals SUT documents "serialize concurrent invocations to avoid registry contamination"). |
| Duplicated permissions | `readKeys`/`writeKeys` on the agent's `permissions` AND on the node | Same lists in two places; can silently diverge. |
| Registry → UUID → node | `const ID = registry.register(...)` then `agentId: ID` | Indirection for what is just "name an agent, reference it". |
| Verbose node config | `failurePolicy: {…4 fields…}`, `requiresCompensation: false` on every node | Defaults would do. |
| Manual persistence | `persistStateFn: async (s) => { await save…; await save… }` | A provider you already have should plug in. |
| Provider redundancy | `model: 'claude-sonnet-4-6'` AND `provider: 'anthropic'` | The model name implies the provider. |

None of that describes flow. All of it can go while `nodes`/`edges` stay exactly as legible.

## Direction (decided 2026-08-04)

- **Keep `nodes` + `edges` explicit.** Topology stays visible — conditional edges and loops are spelled out, because they are cycgraph's reason to exist. A flow-hiding fluent/declarative facade was rejected for this reason.
- **Additive Phase 1.** New ergonomics layer on top of the existing API; `createGraph`/`GraphRunner`/registries untouched; mc-ai-api (which executes stored graph JSON, not `createGraph` calls) is unaffected.
- **Globals retirement is Phase 2**, coordinated with mc-ai-api, since scoping the registry/providers into a run is the change that fixes the multi-tenant footgun.

## The vocabulary (decided 2026-08-04)

A small, consistent family of terse constructors — the authoring surface reads as a sentence: *define agents and nodes, build a graph, seed state, run it.*

| Terse | Returns | Verbose alias (retained) |
|---|---|---|
| `agent(spec)` | an agent value (capability) | — (new) |
| `node(spec)` | a node value (placement) | — (new) |
| `graph({ nodes, edges })` | a graph | `createGraph` |
| `state(input)` | a workflow state | `createWorkflowState` |
| `run(graph, input)` | final memory | — (new) |
| `tool(spec)` | a defined tool | `defineTool` |

One implementation per constructor; the verbose name is an alias, not a fork. The `tool` alias was added 2026-08-04 (Will's call — `defineTool` and `createWorkflowState` read as odd ones out next to the terse family); `defineTool` stays since it's published.

## API design (Phase 1)

### `agent(spec)` — an agent as a value

```typescript
import { agent } from '@cycgraph/orchestrator';

const researcher = agent({
  id: 'research',
  model: 'claude-sonnet-4-6',       // provider inferred: claude-* → anthropic
  instructions: 'You are a research specialist…',
  reads: ['goal', 'constraints'],
  writes: 'research_notes',          // string or string[]
});

const writer = agent({
  id: 'write',
  model: 'claude-sonnet-4-6',
  instructions: 'You are a writer…',
  reads: ['goal', 'research_notes'],
  writes: 'draft',
});
```

- Returns a reusable value (usable in multiple graphs). No registry call, no UUID threading.
- `id` doubles as the node id that edges reference.
- Provider inferred from the model-name prefix (`claude-*` → anthropic, `gpt-*`/`o*` → openai), overridable with `provider:`. Ollama/custom stay an explicit provider.
- `reads`/`writes` are the single source of truth for permissions — the facade fills both the node's `read_keys`/`write_keys` and the agent config's ceiling from them.
- Passthrough for the rest (`temperature`, `tools`, `maxSteps`, `memoryQuery`, `budget`, `modelPreference`), so nothing is lost versus the raw config.

### `graph` accepts agent values, `node` values, and edge sugar

`graph` (alias `createGraph`) stays THE graph constructor — one mental model — extended additively:

```typescript
import { agent, node, graph } from '@cycgraph/orchestrator';

const g = graph({
  name: 'research-write',
  nodes: [researcher, writer],       // agent values, node() values, or full specs
  edges: [
    { from: 'research', to: 'write' },
    // conditional + loop stay explicit:
    { from: 'review', to: 'research', when: 'memory.score < 0.7' },
  ],
});
```

- A `nodes` entry that is an `agent()` value expands to `{ id, type: 'agent', agent_id, read_keys, write_keys }` with perms derived.
- `node(spec)` is the terse constructor for non-agent node types (supervisor, tool, reflection, evolution, …): `node({ id: 'route', type: 'supervisor', … })`. Full node specs are still accepted verbatim.
- Edge sugar `{ from, to, when }` maps to the wire `{ source, target, condition }`: no `when` → `{ type: 'always' }`; with `when` → `{ type: 'conditional', condition: <filtrex> }`. The structured wire edge is still accepted.
- `startNode`/`endNodes` inferred when unambiguous (start = the single node with no inbound edge; ends = nodes with no outbound edge), overridable explicitly. Ambiguous or fully-cyclic graphs require them — a clear error, not a guess.

### `run(graph, input, opts?)` — one call to execute

```typescript
const { draft } = await run(graph, {
  goal: 'Explain how LLMs work',
  constraints: ['Under 300 words'],
});
```

- Builds `WorkflowState` from `input` (`goal` required; other keys seed memory).
- Defaults to in-memory persistence; pass `opts.persistence` (a `PersistenceProvider`) to swap it — no `persistStateFn` closure.
- Phase-1 bridge: `run` wires the agent values into the existing global factory internally (calls `configureAgentFactory` for you), so the globals still exist but the user never sees them. Concurrency caveat from the globals remains until Phase 2; documented.
- Returns the final memory as `Record<string, unknown>` — always the same shape (no per-graph generic typing; that weight isn't worth it). Enables `const { draft } = await run(...)`. When you need run metadata (status, cost, taint), use the raw `GraphRunner` directly — facade for the common case, raw API for the rest.
- `state(input)` is available when you want to build/seed the workflow state explicitly instead of passing raw `input` to `run`.

## What stays explicit vs derived

| Explicit (author writes it) | Derived / defaulted (facade supplies) |
|---|---|
| Nodes and what each does | Agent UUID + registry wiring |
| Edges, conditions, loops | Node `read_keys`/`write_keys` (from `reads`/`writes`) |
| Model + instructions | Provider (from model name) |
| `writes` / `reads` | Provider registry setup |
| Advanced node config when used | Failure policy, `requires_compensation` defaults |
| | Persistence (in-memory unless overridden) |
| | Start/end nodes (when unambiguous) |

## Compiles to the same wire

The facade is authoring sugar only. `createGraph` still emits the exact snake_case `GraphSchema` wire; `run` still drives `GraphRunner`. Consequences:

- Serializable graphs, architect output, Postgres persistence, workflow bundles — all unchanged.
- mc-ai-api consumes the compiled wire, so Phase 1 is invisible to it.
- The deterministic eval gate must stay at 0.0% drift: no existing path changes behavior.
- Consistent with the established camelCase authoring + tool-source-sugar precedent (`types/case-mapping.ts`): author in the light form, store the structured wire.

## Serialization & JSON

The graph stays pure JSON — an invariant, verified against the schema: `agent_id` is a plain string, registry ids are plain strings, and `createGraph` output carries no `Date`s, functions, or version/timestamp fields (those are persistence-layer concerns). So `graph()`/`createGraph()` emits the canonical snake_case `GraphSchema` wire and `JSON.stringify(graph)` already produces exactly what Postgres stores, the architect emits, and mc-ai-api executes. **No graph→JSON helper is needed; the graph is JSON.**

Two design consequences:

- **Stable, human-readable ids.** The facade uses `agent({ id: 'research' })`'s `id` as BOTH the registry id and the node's `agent_id` (both accept plain strings). Result: deterministic, readable graph JSON (`agent_id: 'research'`) instead of a per-run random UUID. This deliberately differs from "don't hand-manage agent UUIDs" (that rule targets hand-threaded `uuidv4()`; a declarative facade-managed id is not that), and the payoff is reproducible JSON. Duplicate ids within a graph are a construction error.
- **Graph JSON references agents; it does not embed them.** The agent *definitions* live in the registry, keyed by id. `JSON.stringify(graph)` captures topology + node config, not the agent bodies. This is unchanged from today — the facade only makes it more visible because agents are authored inline.

**The helper that earns its place is workflow→JSON, not graph→JSON.** A minimal export that bundles the graph plus the agent definitions it references (later: MCP server refs, required custom-tool names) so a facade-authored workflow round-trips / persists / shares. This overlaps the workflow-bundles effort (portable artifacts + npx runner); introduce the minimal `{ graph, agents }` export here and let the full bundle format build on it. Deferred decision: exact shape and whether it lands in this pass or immediately after.

## Phase 1 deliverables

- `src/authoring/` module: `agent()` (+ spec type), `node()`, `state()` (wraps `createWorkflowState`), `run()`; edge-sugar + agent/`node`-value expansion in `graph`/`createGraph`; model→provider inference; start/end inference.
- Barrel exports: terse `agent`, `node`, `graph`, `state`, `run` plus the new spec types; `createGraph`/`createWorkflowState` remain as aliases.
- Tests: agent-value expansion, `node()` expansion for a non-agent type, permission derivation, edge sugar → wire, provider inference + override, start/end inference (and the ambiguous-graph error), a full `run()` executing a two-node graph with a mocked provider, and a proof that a facade-authored graph and the equivalent hand-authored `createGraph` produce identical wire.
- Rewrite `examples/research-and-write` with the facade (target ~15 lines) alongside a note pointing to the raw API for advanced use.
- Docs: a "Quickstart" that leads with the facade; `concepts/graphs` gains a short "authoring shortcuts" section; the raw API stays fully documented for cyclic/advanced patterns.
- Changeset (orchestrator minor; additive).

## North star (vision — not scoped here, informs the design)

**Shareable, installable graphs**: a community publishes graphs as npm packages; you `npm install` one and drop it into your own graph as a subgraph node. The architecture already leans toward this — three existing pieces converge:

- **Composition**: the `subgraph` node type already references and runs another graph by id (scoped `input_mapping`/`output_mapping`, cycle detection, `MAX_SUBGRAPH_DEPTH=32`). This IS the "extend a node with someone else's graph" mechanism, shipped.
- **Portability**: graphs are pure JSON referenced by id (see Serialization above).
- **Distribution**: a "graph package" is just an npm package that default-exports a `graph()` value or a bundle JSON; consume it as `subgraph(childGraph)`. npm needs no new registry infra.

What's genuinely missing (build on existing foundations, not new ones):

1. **Requirements manifest** — a graph isn't self-contained; it references agent defs, declares required custom tools by name, and may need MCP servers + provider keys. A shareable graph is a bundle + a peerDependency-like manifest ("needs an Anthropic key, a `web_search` tool, these MCP servers") that install-time validation checks. This is the real spec work; it extends the workflow-bundle format.
2. **Reproducibility/verification** — pin model ids; ship the graph's own eval suite (golden trajectories) so a consumer runs its gate locally to confirm behavior before trusting it. The evals harness becomes the verification layer.
3. **Trust — the moat.** Running a third-party graph with your keys/data is safe *because of* the security model already built: per-node `read_keys`/`write_keys` least-privilege, taint tracking on external data, the MCP allowlist + custom-tool-by-name contract (the consumer supplies implementations), sandboxed_js / no host shell, and the subgraph I/O mapping as the isolation boundary. "Install and run an untrusted agent workflow safely" is differentiating (LangChain templates are copy-paste; no isolation).

Design implication for THIS pass: the workflow→JSON export (Serialization section) should assume **multi-graph bundles** — a parent plus the transitive closure of referenced subgraphs and their agents — rather than a single graph, so the format doesn't have to be reworked when this lands.

## Phase 2 — IMPLEMENTED 2026-08-04 (scoped-primary, globals deprecated)

Retired the process-global agent/provider config as the *internal* mechanism; the globals remain as a deprecated fallback so mc-ai-api migrates at its pace.

- `GraphRunnerOptions.registry` / `.providers` build a run-scoped `AgentFactory`; without them the runner uses the global default (deprecated path).
- The four executors (agent, supervisor, evaluator, extractor) no longer read the global singleton — they receive the factory through the executor-context deps, injected from `runner.agentFactory`. The context builder always wraps them now (previously wrapped only when a rate limiter was present).
- `run()` passes `registry`/`providers` scoped — no global mutation — so concurrent facade runs are isolated. This is the footgun fix.
- `configureAgentFactory` / `configureProviderRegistry` marked `@deprecated`; still functional.
- Removed the factory's blunt non-UUID guard (it blocked the facade's human ids even for in-memory registries); the Postgres adapter's `loadAgent` now defensively returns `null` for non-UUID ids, keeping the `uuid` column safe. This also fixed a latent Phase-1 bug: facade human ids could never actually load.

Verified: scoped-isolation test (two runs, same agent id, different registries, no contamination), orchestrator 2073 tests + coverage, Postgres 252 tests against a real DB, deterministic gate 0.0%.

## Inline tool references — SHIPPED 2026-08-05

Tools now ride the same reference pipeline as agents, closing the seam where custom tools were declared by name on the agent but registered separately on the runner. A `tool()` value passed directly in any agent or node `tools` array is collapsed by `graph()` to its serializable `{ type: 'custom', name }` wire source, the implementation is stashed on the graph (`toolsForGraph`, a WeakMap keyed on graph identity like `agentsForGraph`), and `run()` merges the stash into the runner's `tools` option (identity-deduped against explicit `runner.tools`; two distinct tools sharing a name are a compile-time `GraphSpecError`).

Mechanics: `isDefinedTool` is the canonical shape guard (exported; registry.ts uses it too), `ToolSourceInputSchema` gained a `z.custom<DefinedTool>` branch so every authoring boundary (`createGraph`, `registry.register`) accepts a tool value and collapses it to its name, `resolveRefs` collects tool references through a `RefCollector` (agent + tool callbacks), and `toRegistryConfig` surfaces agent-spec tool refs to the same collector. Serialized graphs carry only names — implementations never serialize — so the raw-API/registered-by-name path is unchanged and remains the story for reloaded graphs. Run-path test proves an inline tool reaches the agent executor resolved and executable through a real GraphRunner (`test/inline-tools-runpath.test.ts`).

## Production-hardening review — FIXED 2026-08-05

An adversarial walkthrough of the facade + scoping + derived-reads work surfaced 13 findings; all are fixed and battery-verified (orchestrator 2097 tests + coverage, Postgres 255 vs real DB, tools 155, clean-slate root build, eslint, deterministic gate 0.0%).

The load-bearing ones:

1. **Derived supervisor reads were dead code on the production path.** The derivation lived only in the executor-context `createStateView` closure, which no production code calls; the real path (`node-execution-driver`) built views from raw `read_keys`. Now both paths go through a shared `withEffectiveReads(node, graph)` helper, and the security-policy gate at the call site resolves the same derived node, so derived reads are taint-gated (skipping that would have made the derivation a policy bypass). Guarded by a run-path test that fails if the driver wiring reverts — the lesson from this bug is that closure/unit tests masked it; run-path tests through `runner.run()` are the standard now.
2. **Subgraph children escaped run scoping.** Child runners now inherit the parent's original `registry`/`providers`/`tools` options via the executor context. This also caught a second latent bug: `subgraph.ts` still passed the removed `toolResolver` option (silently ignored — child subgraphs had NO tool resolution since the tools rework). The ORIGINAL `tools` array is threaded, not the composed resolver, because re-wrapping the parent's composition as a child leg would misroute custom-tool sources.
3. **`run()` scoping semantics.** The run registry is created only when the graph carries facade agents; raw graphs fall back to the caller's config. `runner.registry` alongside inline agents throws loudly. Providers are scoped only when given, so global Ollama-style registrations survive `run()`. `buildRunAgentFactory` inherits the global factory's other half under partial scoping (new `getRegistry()`/`getProviderRegistry()` on `AgentFactory`); scoped factories always fail closed.
4. Batch: dup-pinned-agent-id compile error; `resolveRefs` preserves `Date`/non-plain objects (plain-object recursion, mirroring `camelToSnakeDeep`); `http_request` lowercase-normalizes headers before the defaultHeaders merge (released `@cycgraph/tools` — patch changeset); raw `agentId` defaults node type to `agent`; `inferProvider` returns null for `gpt-oss*` and dropped legacy `text-`/`davinci`; agent `name`/`description` JSDoc + docs no longer claim they drive supervisor routing (routing uses node ids); Drizzle `updateAgent`/`deleteAgent` treat non-UUID ids as clean not-found.

### Next breaking pass (bundle these together, coordinated with mc-ai-api)

Deferred breaking changes to land in one pass rather than as separate churn:

1. **Hard-remove the deprecated globals** (`configureAgentFactory` / `configureProviderRegistry`) once mc-ai-api has migrated to `GraphRunnerOptions.registry` / `.providers`.
2. **Promote `registry` to a first-class `RunOptions` field** (currently reachable only via `runner.registry`) so the facade reads `run(g, input, { registry })`. Additive, but fits naturally in the same pass.
3. **Remove the deprecated `*Fn` option aliases** (`persistStateFn`, `loadGraphFn`, `persistDeltaFn`) — renamed 2026-08-04 to `persistState` / `loadGraph` / `persistDelta` (primary wins when both given); aliases kept for published-API compatibility until this pass.
4. **Rename `Drizzle* → Postgres*`** across `@cycgraph/orchestrator-postgres` (all 10 classes: `PostgresAgentRegistry`, `PostgresPersistenceProvider`, …). Rationale (decided 2026-08-04): the class name should carry what the consumer acts on — they provision Postgres and set `DATABASE_URL`; they never touch Drizzle's ORM API, so "Drizzle" leaks an invisible internal detail. `Postgres*` is precise, consumer-meaningful, and a coherent family rename (unlike `Persistent*`, which overclaims a generic capability and would block a future second persistent backend). The generic/unbranded concept stays the `AgentRegistry` interface. Kept as `Drizzle*` for now to avoid standalone breaking churn.

## Decisions (resolved 2026-08-04)

1. **Node id source** — RESOLVED: `agent({ id })` doubles as the node id. No `.as()` placement-renaming for now (revisit only if reuse-under-different-ids is actually needed).
2. **Start/end inference** — RESOLVED: infer when unambiguous (start = the single node with no inbound edge; ends = nodes with no outbound edge); require explicit `start`/`end` otherwise, with a clear error rather than a guess.
3. **`run` result type** — RESOLVED: always the same shape, `Record<string, unknown>` (the final memory). No per-graph generic typing. Run metadata (status/cost/taint) comes from the raw `GraphRunner` when needed.
4. **Naming** — RESOLVED: terse family `agent` · `node` · `graph` · `state` · `run` (verbose `createGraph`/`createWorkflowState` retained as aliases). `defineTool` stays as shipped; a `tool` alias is a possible later, not this pass.
5. **`reads` default** — RESOLVED: keep least-privilege — `reads` omitted → the node sees only `goal`/`constraints`, matching the current `read_keys` default. Nothing is inferred into `reads`.
