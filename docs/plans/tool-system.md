# Tool System Expansion Plan

**Status**: All three phases implemented 2026-08-03 (uncommitted; changesets `custom-tool-layer` + `tools-package`). Phase 3 landed as `packages/tools`; the library roadmap below tracks its growth. Tier 1 shipped 2026-08-03.
**Created**: 2026-08-03
**Scope**: `packages/orchestrator` (custom tool interface, builtin consolidation), new `packages/tools` workspace.

## Goal

Make tools a first-class extension surface of the orchestrator, in three layers:

1. **Built-in tools**: a small, trusted, dependency-free set shipped with the engine, consolidated into one directory.
2. **Custom tools**: an easy, schema-first interface for hosts to register their own tools without implementing a full `ToolResolver` or wrapping functions in an MCP server.
3. **Optional tools**: a curated `@cycgraph/tools` package of pre-built, plug-in tools that registers through the same custom-tool interface.

MCP remains the path for third-party and out-of-process tools. Nothing in this plan changes the MCP registry, transport security, or connection manager.

## Current state

- `ToolSource` (`types/tools.ts`) is a two-variant discriminated union: `builtin` with a closed enum of four names (`save_to_memory` plus the three architect tools), and `mcp` with `server_id` + optional `tool_names`.
- Resolution goes through the `ToolResolver` interface (`mcp/connection-manager.ts:49`): `resolveTools(sources, agentId)`, `closeAll()`, optional `drainTaintEntries(tools)` for per-execution taint collection. `MCPConnectionManager` is the only real implementation.
- When no resolver is configured, `runner/fallback-tool-resolver.ts` handles `save_to_memory` inline, warns on MCP sources, and echo-proxies unknown names so examples run without infrastructure.
- The gap: a host with a ten-line custom function must either implement the entire `ToolResolver` (replacing MCP resolution wholesale) or stand up an MCP server. There is no compositional middle.
- `GraphNode.tools` overrides agent-config tools per node. Tool nodes execute a single `tool_id` and write `${id}_result`. Graph validation already fails fast when a node declares MCP sources but no resolver is configured (`graph-runner.ts` preflight).

## Design principles

1. **Graphs stay serializable.** Config references tools by name; implementations are injected at runtime. This is what keeps architect-generated graphs, Postgres persistence, and future workflow bundles working. Never accept a function in a schema.
2. **Injection over import.** Registration follows the established `GraphRunnerOptions` pattern used by `memoryRetriever`, `memoryWriter`, and `contextCompressor`.
3. **Composition, not replacement.** The custom-tool layer composes with the MCP `ToolResolver` instead of superseding it. The public `ToolResolver` interface does not change.
4. **Fail at validation, not mid-run.** An unresolvable tool name is a preflight error, mirroring the existing MCP-without-resolver check.
5. **Security parity.** Every tool layer gets Zod input validation, a taint policy, and the same secrets rules. Builtins must be pure: no network, no fs, no child_process.

## Target architecture

```
Agent / node config (authoring):  tools: ['save_to_memory', 'lookup_order', { mcp: 'web-search' }]
                                        │  normalized to the wire union by the
                                        │  camelCase authoring layer (case-mapping)
                              resolution pipeline
                        ┌───────────────┼────────────────┐
                        ▼               ▼                ▼
                  builtin registry  DefinedTools      ToolResolvers (e.g. MCP)
                  (src/tools/)      (options.tools)   (options.tools, interface unchanged)
                        └───────────────┴────────────────┘
                                        ▼
                          merged AI SDK toolset → agent executor
                          taint entries → per-execution collector
```

## Phase 1 — Custom tool interface + resolution pipeline

The enabling seam. Everything else consumes it.

### 1.1 `defineTool()` helper

```typescript
import { defineTool } from '@cycgraph/orchestrator';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by ID from the host system',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.find(orderId),
  taints: false, // default; set true for tools ingesting external data
});
```

Spec shape (runtime only, never persisted):

```typescript
export interface DefinedToolSpec<TArgs extends z.ZodType = z.ZodType> {
  name: string;          // ^[a-z0-9_-]+$, rejected on collision with BUILTIN_TOOL_NAMES
  description: string;
  parameters: TArgs;     // Zod; converted to JSON Schema for the LLM
  execute: (args: z.infer<TArgs>) => Promise<unknown> | unknown;
  taints?: boolean;      // default false — first-party code is trusted (decided 2026-08-03)
  timeoutMs?: number;    // default aligned with MCP per-tool timeout
}
```

`taints` lives here, on the implementation, and deliberately NOT on the wire `ToolSource`: a persisted graph must not be able to opt its data out of tainting, and tool sources stay pure serializable references.

- Validates `name` (same charset rule as MCP server ids) and rejects collisions with `BUILTIN_TOOL_NAMES`.
- Wraps `execute` with Zod parsing of args, per-tool timeout (default aligned with MCP per-tool timeout), and structured error capture so a throwing tool degrades to a tool-error result instead of killing the node.
- When `taints: true`, output strings are routed into the same per-execution taint collector `drainTaintEntries` drains, so custom-tool taint lands in `state.taint_registry` exactly like MCP taint.

### 1.2 Authoring surface: no `type` field for authors

The discriminated union stays as the **stored wire format**. It exists for a reason recorded in `types/tools.ts`: it deliberately replaced bare `string[]` references because strings conflated builtins with MCP-provided tools, and the MCP variant needs structure (`server_id` + optional `tool_names` filter). It is also already persisted in agent configs, so the wire form should not churn.

Authors, however, never write it. The camelCase authoring layer (`types/case-mapping.ts`, applied by `createGraph` / registry constructors) accepts a lighter form and normalizes:

```typescript
tools: [
  'save_to_memory',                         // bare name → resolved locally
  'lookup_order',                           // ditto, host-registered
  { mcp: 'web-search', tools: ['search'] }, // server ref, optional tool filter
]
```

```typescript
export type ToolSourceInput =
  | string                               // 'save_to_memory', 'lookup_order'
  | { mcp: string; tools?: string[] }    // { mcp: 'web-search', tools: ['search'] }
  | ToolSourceConfig;                    // full structured form, still accepted
```

Normalization rules: a bare string becomes `{type:'builtin', name}` when the name is in `BUILTIN_TOOL_NAMES`, else `{type:'custom', name}` (new union variant, same charset rule as MCP server ids); `{ mcp: id, tools }` becomes `{type:'mcp', server_id: id, tool_names: tools}`. The structured form remains accepted for authors who want it; its mechanically derived camelCase field stays `toolNames` since it mirrors the wire. A pleasant side effect: the builtin/custom distinction disappears from the authoring surface entirely — both are just "a named tool that resolves locally" — while the wire keeps the distinction for validation and persistence. Schema bump is additive, so no `state_schema_version` migration.

### 1.3 One `tools` option on `GraphRunnerOptions`

```typescript
const runner = new GraphRunner(graph, state, {
  tools: [lookupOrder, submitTicket, mcpManager],
});
```

`tools?: Array<DefinedTool | ToolResolver>` — a single option accepting anything that provides tools. Entries are discriminated at runtime by shape: an `execute` function marks a `DefinedTool`, a `resolveTools` function marks a `ToolResolver`. The MCP connection manager stops being a special-cased option and becomes one provider among several; the `ToolResolver` interface itself does not change, so `MCPConnectionManager` needs no edits.

- **Precedence**: builtin registry first, then `DefinedTool` entries in array order, then resolvers in array order. Duplicate names across entries are a preflight error, not a silent shadow.
- **Lifecycle**: the runner invokes `closeAll()` and `drainTaintEntries()` on every resolver entry that implements them, merging drained taint.
- **`toolResolver` is removed** as an option — a clean break, consistent with the pre-0.1.0 camelCase conversion. Migration is mechanical: `toolResolver: m` → `tools: [m]`.
- **Naming echo**: node config `tools` declares what a node *wants* (names on the wire); the runner option `tools` supplies what *exists* (implementations). One doc sentence covers this deliberately.

Internally `composeToolResolution()` builds the pipeline; `executor-context-builder.ts` swaps its current either/or wiring (resolver or fallback) for it. The fallback resolver's builtin handling migrates into the builtin registry; its echo proxy survives only when `options.tools` is absent entirely, preserving today's example/test ergonomics while never masking a missing registration in a wired-up deployment.

### 1.4 Preflight validation

Extend the runner preflight: a node declaring `{type:'custom', name}` for a name no `options.tools` entry provides fails at start with a `NodeConfigError`-style message, exactly like the MCP-without-resolver check. `validateGraph` cannot check this statically (it has no registry), so it stays a runner-level check; `validateGraph` gains only the schema-level variant validation for free.

### 1.5 Tool nodes

`executeToolNode` currently resolves `tool_id` through the same toolset path, so custom tools work in tool nodes with no extra work. Add a test proving `${id}_result` and taint routing for a `taints: true` custom tool.

### Deliverables

- `src/tools/define-tool.ts`, `src/tools/registry.ts` (composition pipeline), schema change + authoring sugar in `types/tools.ts` / `types/case-mapping.ts`, preflight check, barrel exports (`defineTool`, `DefinedTool`, `CustomToolSource` types).
- `TaintMetadataSchema.source` gains `'custom_tool'` so tainting custom tools write `{ source: 'custom_tool', tool_name, created_at }` through the existing reducers. Both schema changes are additive enum/discriminant members: no `state_schema_version` or `REPLAY_VERSION` bump.
- Tests: schema round-trip including string/`{mcp}` sugar normalization, resolution precedence, duplicate-name rejection, timeout, error capture, taint routing under concurrent executions (voting/map), preflight failure, `tools` array shape discrimination.
- Docs: extend `concepts/tools-and-mcp.md` with the custom layer; new short guide `guides/custom-tools.md`.

## Phase 2 — Builtin consolidation

Mechanical, low risk, best done immediately after Phase 1 so builtins land in the new registry shape.

- Create `src/tools/builtin/` and move the `save_to_memory` definition out of `fallback-tool-resolver.ts`; architect tools keep their implementations in `architect/` but register their declarations through the builtin registry so there is exactly one builtin catalog.
- `BUILTIN_TOOL_NAMES` stays a closed enum. Builtins are engine-shipped and trusted; a schema-validated closed set is a feature. Adding a builtin remains a deliberate schema change.
- Admission rule, enforced in review: builtins are pure and dependency-free. Anything touching network, fs, or subprocess goes to `@cycgraph/tools` or MCP.
- Candidate new builtins (each its own small decision, none blocking): `get_current_time` (replay-safe: sourced from action metadata time, not `Date.now()`), `json_query` (pure jq-lite over readable state keys).

## Phase 3 — `@cycgraph/tools` package

A consumer of Phase 1 with zero special status: it exports `defineTool` results the host registers like its own.

- New workspace `packages/tools`, structure mirroring sibling packages (strict TS, vitest with ratcheted coverage, eslint scope added to `eslint.config.mjs`).
- Subpath exports per family so deps stay opt-in: `@cycgraph/tools/web`, `@cycgraph/tools/data`, `@cycgraph/tools/text`. Heavy deps are optional peer deps of their subpath.
- Initial set, deliberately small and high-bar:
  - `web_fetch` (`/web`): HTTP GET with the SSRF guard reused/extracted from `mcp/transport-security.ts`, response-size cap, `taints: true`.
  - `http_request` (`/web`): structured request tool, allowlist-first configuration, `taints: true`.
  - `calculator` (`/data`): pure expression evaluation via a small built-in tokenizer + recursive-descent parser (no `eval`, no dependency).
  - `json_transform` (`/data`): pure, schema-validated JSON reshaping.
- Every tool ships with: Zod schemas, taint declaration, docs page section, unit tests, and an evals consideration (does it need a deterministic gate entry?).
- Quality bar stated in the package README: this is a curated set, not a grab-bag. New tools need a maintenance owner and tests, or they go in user land.

## Library roadmap (`@cycgraph/tools`)

Curation filter: product-specific integrations (Slack, GitHub, Notion) stay MCP's job. The library earns its place with capabilities that are general, benefit from the shared security plumbing, or exploit cycgraph's own differentiators.

**Tier 1 — shipped 2026-08-03**
- `web_search` (`/web`): Brave/Tavily backends, normalized results, works under `MCP_STDIO_DISABLED` where the default Brave MCP server cannot.
- `html_to_markdown` (`/web`) + `extract` option on `web_fetch`: streaming HTML → markdown/text, the context-efficiency multiplier for web workflows.
- `memory_search` (`/memory`, optional peer on `@cycgraph/memory`): agent-initiated retrieval by tags / seed entities / free text via `embed` hook; `scopeTags` enforced as a result filter because the underlying tag query is any-of. Known gap: tool-initiated retrieval is not recorded in `state.lesson_provenance` (prompt-injection only); fact ids are returned for caller-side attribution — engine wiring for tool-path provenance is a candidate follow-up.
- `current_time` (`/data`): timezone-aware; replay-safe because tool results are event-log recorded (this closes open decision #6 — the builtin variant stays unbuilt).

**Tier 2 — shipped 2026-08-03**
- `csv_parse` (`/data`): hand-rolled RFC-4180 parser (quotes, escapes, CRLF); header/positional modes; row-capped output with `totalRows` + `truncated`.
- `stats` (`/data`): count/sum/mean/median/min/max, sample stdDev, interpolated p25/p75/p95.
- `text_extract` (`/data`): the ReDoS guard is a worker thread terminated at the deadline — a promise race cannot interrupt synchronous backtracking, so the timeout must be structural. Plus pattern (200), input (100 KB), and match-count caps; zero-width-match advance guard.

**Tier 3 — needs dedicated design + Security Expert review**
- `sandboxed_js`: code-interpreter capability via a WASM-embedded engine (quickjs-emscripten). **Shipped 2026-08-04** — design doc [sandboxed-js.md](./sandboxed-js.md); `@cycgraph/tools/sandbox`, QuickJS-in-WASM inside a terminatable worker, 30 tests incl. the escape-probe checklist.
- ~~Read-only `sql_query`~~ **Ruled out of the curated library (decided 2026-08-04): user-authored.** A model-authored query string is the same footgun as a shell command — "read-only" can't be enforced from the string (side-effecting CTEs, `pg_sleep` DoS, catalog recon, runaway joins), and real safety is a deployment posture (read-replica, restricted role, statement timeouts) not argument validation. Users who need DB access author it themselves: an MCP database server registered in the trusted registry (ideally task-shaped tools, not raw `run_sql`), or their own `defineTool` with connection and guardrails they own. Keeps the Tier 3 invariant intact — the model invokes typed operations an operator defined, never authors an executable string.

**Ruled out (decided 2026-08-03): host command-line execution.** A shell tool is `child_process` with model-authored input — prohibited by the security mandates, and an injection-to-shell chain is concrete here (`web_fetch` puts attacker-controllable content into the same context that authors tool calls; taint tracking records the flow but cannot launder-proof it, so the control must be a sandbox boundary, not input filtering). The MCP stdio transport is not a precedent: there the operator authors the command via the trusted registry and the model only calls exposed tools; a shell tool inverts who authors the argv. If command-line needs emerge:
1. `sandboxed_js` covers most compute cases with zero processes.
2. A container-backed executor (`/exec` as a thin client to an operator-run sandbox: no network, read-only rootfs + tmpfs workdir, resource limits, scrubbed env; factory refuses to exist without the sandbox endpoint) — a deployment component with a library client, mirroring the persistence pattern. Design doc + Security Expert review first.
3. Cheapest near-term path for specific binaries: dedicated MCP stdio servers exposing task-shaped tools ("clone this repo", not "run this string"), staying inside the existing registry/allowlist/env-scrub machinery.
Invariant: the model never authors an executable string; it invokes typed operations whose execution surface an operator defined.

## Cross-cutting

- **Architect**: the composed registry exposes `listTools()` returning `{name, description, parameters}` per tool. `ArchitectToolDeps` gains an optional tool catalog so generated graphs reference tools that actually exist; the architect validator can then reject drafts naming unknown tools at draft time.
- **Workflow bundles**: bundles declare required tool names; the bundle runner checks them against the composed registry before execution. This plan deliberately makes that check cheap. (Note: the previous `docs/plans/workflow-bundles.md` file is no longer in the tree; its decisions need re-recording before that intersection is firmed up.)
- **Evals**: the SUT's mock-tool fixtures can migrate to `options.tools` registration, replacing bespoke resolver plumbing in `orchestrator-sut.ts`. Not urgent; do it when the fixtures next change.
- **Docs**: `concepts/tools-and-mcp.md` restructures around the three layers plus MCP; sidebar unchanged otherwise.

## Security review checklist (gate before merge, per phase)

- [ ] Custom tool names cannot shadow builtins or MCP-resolved names silently; precedence documented and tested.
- [ ] `taints: true` output verifiably lands in `state.taint_registry` under concurrent executions.
- [ ] No secrets flow: custom tools receive only their parsed args, never provider keys or full state.
- [ ] `@cycgraph/tools` network tools pass the SSRF guard tests (private/loopback/metadata hosts rejected).
- [ ] Per-tool timeout enforced for custom tools; a hung tool cannot stall a node past its budget.
- [ ] Fallback echo proxy provably disabled once any real registration exists.

## Open decisions

1. ~~Option name~~ **Resolved 2026-08-03**: a single `tools?: Array<DefinedTool | ToolResolver>` option replaces `customTools` + `toolResolver` (clean break on `toolResolver`); authoring accepts bare strings / `{ mcp: id }` sugar so the `type` field never appears in user code, while the wire keeps the discriminated union.
2. ~~Taint default for custom tools~~ **Resolved 2026-08-03**: `taints: false` by default — custom tools are first-party code; tools ingesting external data opt in with `taints: true`, and everything network-touching in `@cycgraph/tools` sets it.
3. **Package name**: `@cycgraph/tools` (proposed) vs `@cycgraph/toolkit`.
4. **Per-node custom registration**: not proposed. Registration is per-runner; nodes select by name via `tools`. Revisit only if a multi-tenant runner needs per-node isolation.
5. **Agent registry persistence**: `{type:'custom', name}` persists in agent configs like any ToolSource. Confirm no registry-side validation should reject unknown names at registration time (proposal: no; availability is a runtime property).
6. **`get_current_time` builtin**: needs the replay-determinism story (`timeOf(action)` source) agreed before adding; otherwise defer.

## Sequencing

Phase 1 → Phase 2 in one release (minor version, additive schema). Phase 3 as its own release once 1+2 are stable. Docs land with each phase, not after. All three CI Lint & Build steps reproduced locally per phase; deterministic eval gate must stay at 0.0% drift since no observable behavior of existing paths changes.
