# @cycgraph/orchestrator

## 0.14.0

### Minor Changes

- 37d6451: Agent2Agent (A2A) interop: delegate a graph step to a remote agent.

  New `a2a` node type, sibling to `subgraph`: same mapping convention and
  implied write grants, but budget and capability ceilings deliberately stop
  at the network boundary and everything returned is taint-tracked. A remote
  `input-required` pauses the run through the existing HITL machinery and
  resumes the same remote task, including when nested inside a subgraph.
  `rejected` and `auth-required` tasks are classified non-retryable.

  Supporting pieces: a trusted `A2AServerRegistry` (SSRF-guarded Agent Card
  URLs, credentials as named env vars, per-server `propagateTraceContext`),
  an `A2AClient` port so core carries no protocol dependency, `toAgentCard` /
  `agentCardFidelity` for publishing a graph's interface, and the new
  `@cycgraph/a2a` package implementing the port on `@a2a-js/sdk`.

- 37d6451: Engine hardening across the delegation and permission layers: subgraph
  output-mapping targets are implied write grants; supervisors derive reads
  from managed nodes' implied result keys; the graph validator warns on tool
  nodes declaring inert `write_keys` and reflection `source_keys` nothing
  produces; boundary crossing logic (mapping, taint, interface enforcement)
  extracted to a module shared by delegating nodes; `subgraph.run` and
  `a2a.task` tracing spans with an `injectTraceContext` helper for outbound
  W3C trace propagation.
- 37d6451: BREAKING: `ContextCompressor` now receives the whole prompt as segments.

  The compressor is called once per prompt with every variable-size section
  (`system`, `goal`, `retrieved`, `task_context`, `memory`, `instructions`,
  plus `routing_history` for supervisors) instead of a single memory blob, so
  one budget can be allocated across the prompt. Locked segments must be
  returned byte-identical or the whole result is discarded. Memory now
  reaches the compressor uncapped; byte caps apply to output as a backstop.

  Also: agents accept `maxOutputTokens` (no default; forwarded to providers
  and to the compressor as `outputReserve`), and the agent executor captures
  the provider error from the stream, so failures like a 401 surface with
  their real message and stop retrying instead of reporting "No output
  generated" after three attempts.

## 0.13.0

### Minor Changes

- 98557ec: `parseBundle` now cross-checks a bundle's visible usage against its manifest.

  A bundle whose graphs' node sources or bundled agents reference a custom tool, MCP server, or model that the manifest's `requires` never declared is rejected at load time with `BundleIntegrityError`, listing every violation. This moves the common tamper case — a manifest under-declaring to sneak past review — from run time to load time. The runtime capability ceiling remains in place as defense in depth for the one path a bundle cannot show at parse: host-supplied agents referenced by id.

- 98557ec: Bundle manifests can carry provenance: an optional `source` recording where the bundle is distributed from, e.g. an npm package name. Set it at assembly with `bundle(g, { version, source: 'npm:@acme/research-graph' })`. Self-declared attribution for audit trails; for npm distribution, integrity already rides the consumer's lockfile, and `source` records that linkage in the artifact itself. Cryptographic verification is deliberately deferred.
- 98557ec: Capability isolation for bundle children: a graph cannot use more than its manifest declared.

  A bundle's `requires` is now an enforced ceiling, not documentation. When a composition embeds a bundle, its child runner receives a `CapabilityCeiling` derived from the manifest, and enforcement is fail-closed at two layers: the startup wiring check rejects a child graph whose nodes reference a custom tool or MCP server outside the ceiling, and the tool-resolution choke point throws `CapabilityViolationError` for out-of-ceiling sources arriving any other way — including tools on agent configs resolved from the registry at runtime. An invoked parent agent gains nothing, because its tools still resolve under the child's ceiling.

  Nesting can never escape a cap: a child with no declared ceiling inherits its parent runner's, and a bundle nested inside a bundle is capped by the intersection of both manifests. Combined with `checkRequirements`, this completes the app-permissions model — the preflight shows a human exactly what a bundle asks for, and enforcement guarantees the runtime surface matches the reviewed declaration. A tampered bundle whose manifest under-declares what its graph uses now fails instead of silently reaching the host's full tool surface.

  Raw graphs and non-bundle subgraph children are unchanged. New public surface: `CapabilityCeiling`, `CapabilityViolationError`, `intersectCeilings`, and the `capabilityCeiling` / `capabilityCeilings` options on `GraphRunnerOptions`.

- 98557ec: Graph bundles: package a composition as a portable artifact and drop it into another graph.

  `bundle(g, { version })` assembles a `GraphBundle` from a facade-authored composition: a manifest carrying the graph's declared interface and its computed host requirements (`requires`: custom tools with argument schemas, MCP servers, models), plus everything that travels — the entry graph, the transitive child-graph closure, and the agent definitions in wire form. `JSON.stringify(bundle)` is the complete distribution artifact. Implementations never travel: inline `tool()` code stays behind and appears in `requires.tools` for the host to supply by name.

  `parseBundle(data)` validates a bundle arriving from an untrusted source (a file, an npm package), and `subgraph()` now accepts a bundle directly:

  ```ts
  import researchBundle from "@acme/research-graph"; // default-exports a GraphBundle

  const pipeline = graph({
    nodes: [
      subgraph(parseBundle(researchBundle), {
        id: "research",
        inputs: { topic: "goal_in" },
        outputs: { out: "findings" },
        writes: "findings",
      }),
    ],
  });

  await run(pipeline, { goal: "..." });
  ```

  Mappings are validated against the bundle's declared interface at compile time, values crossing the boundary are schema-checked at runtime, and `run()` registers the bundle's agents and resolves its child graphs automatically. New exports: `bundle`, `parseBundle`, `isGraphBundle`, the `GraphBundleSchema` / `GraphManifestSchema` wire schemas, and their types.

- 98557ec: Graphs can declare a public interface, and compositions can compute their host requirements.

  `graph()` accepts optional `inputs` / `outputs` declaring the memory keys a graph expects seeded and produces, authored as Zod schemas (or raw JSON Schema) and serialized as JSON Schema on the wire:

  ```ts
  const research = graph({
    name: "research-block",
    nodes: [
      /* … */
    ],
    inputs: { topic: z.string() },
    outputs: { summary: z.string() },
  });
  ```

  The declaration makes the subgraph boundary a typed call. At compile time, `subgraph()` mappings are validated against the child's declared interface: mapping an undeclared key, or leaving a required input unmapped, is a hard `GraphSpecError`. At runtime, values crossing the boundary are validated against the schemas in both directions and a violation fails the node with the new `SubgraphInterfaceError` — including for children resolved by id that never saw the compile-time check. Graphs without a declared interface behave exactly as before.

  Also adds `computeRequirements(graph)`: walks a composition's `subgraph()` closure and returns the host dependency contract — custom tools (with argument schemas and taint flags when implementations are in scope), MCP server ids, and models. This is the generated half of the upcoming bundle manifest's `requires` block.

- 98557ec: Add `checkRequirements(target, host)`: preflight a composition or bundle against the host environment.

  Pass a `Graph` to compute requirements from the composition closure, or a `GraphBundle` to check its manifest's declared `requires` — which is what makes a deserialized bundle checkable without running it. The host offers its `tools` (only `tool()` implementations satisfy required names), an `mcpServers` registry, and optionally a provider registry for an advisory model check. The result lists exactly what is missing, so a graph that cannot run fails at install or load time with a clear list instead of deep in execution:

  ```ts
  const { ok, missingTools, missingMcpServers, unknownModels } =
    await checkRequirements(parseBundle(theirBundle), {
      tools: [lookupOrder],
      mcpServers: serverRegistry,
      providers: createProviderRegistry(),
    });
  ```

  `ok` reflects the hard requirements (tools and MCP servers). `unknownModels` is advisory, matching the engine's model lists being advisory rather than an allowlist.

- 98557ec: Add `subgraph()` to the authoring facade: compose a child graph into a parent topology as a first-class value.

  ```ts
  const parent = graph({
    name: "parent",
    nodes: [
      subgraph(child, {
        id: "call-child",
        reads: ["topic"],
        writes: "result",
        inputs: { topic: "goal_in" }, // parent key → child key
        outputs: { out: "result" }, // child key → parent key
      }),
    ],
  });

  await run(parent, { goal: "..." }); // no hand-wired loadGraph
  ```

  When the child is a `graph()` value in scope, `run()` resolves it automatically and registers its agents and inline tools transitively, including grandchildren. A caller-supplied `loadGraph` still wins for ids it resolves, which is the seam for pre-registered and third-party graphs. `subgraph()` compiles to the identical `subgraph_config` wire the raw API produces, so serialization, persistence, and the durable runner are unchanged. Also exports `graphsForGraph()` alongside `agentsForGraph()`/`toolsForGraph()`.

## 0.12.0

### Minor Changes

- 7f199d4: Upgrade to Vercel AI SDK v7.

  The engine now runs on `ai@7`, and the provider packages move to their v7-compatible majors: `@ai-sdk/anthropic@4`, `@ai-sdk/openai@4`, and `@ai-sdk/mcp@2`. Internal call sites were updated to the v7 names (`instructions`, `isStepCount`, `onToolExecutionStart` / `onToolExecutionEnd`). The exported orchestrator API is unchanged.

## 0.11.0

### Minor Changes

- c069711: Authoring facade: a small vocabulary for building workflows with far less boilerplate, while keeping the graph topology explicit. Each word means one thing, forming a pipeline:

  - `agent(spec)` — a **capability**: model, instructions, tools. No registry call, no id to manage (`graph()` mints one; pin `id` only for deterministic graph JSON). One value referenced in many places is registered once.
  - `node(spec)` — a **placement**: topology `id`, state grants (`reads`/`writes`, the engine's authoritative permission), and which agent runs there (`agent:`). The value exposes its properties, so references go by value: `edges: [{ from: research, to: write }]`, `startNode`, `endNodes`, and `managedNodes` all accept node values or id strings.
  - `graph({ nodes, edges })` — the **compiler**: resolves agent references anywhere in node configs (`agent:`, `candidateAgentId`, `evaluatorAgentId`, `voterAgentIds`, …) to minted registry ids, expands `{ from, to, when }` edge sugar, infers start/end when unambiguous, and emits the exact same wire as `createGraph` (verified by test). Reference resolution preserves `Date` and other non-plain values in node configs, a node given a raw `agentId` defaults to `type: 'agent'` just like the `agent:` field, and two distinct `agent()` definitions pinned to the same id are rejected at compile time.
  - `state(input)` / `run(graph, input)` — `run` registers the graph's agents into a run-scoped registry, wires providers/state/persistence, executes, and returns the final memory. The run registry is only created when the graph actually carries inline `agent()` definitions; a raw graph resolves agents from whatever the caller configured, and passing `runner.registry` alongside inline agents is a loud error instead of a silent shadow. Providers are scoped only when given, so a globally-registered provider (e.g. Ollama) keeps working through `run()`.
  - `tool(spec)` — terse alias of `defineTool`, completing the vocabulary (`agent` · `node` · `graph` · `state` · `run` · `tool`). `defineTool` and `createWorkflowState` remain as the verbose forms. Tool values ride the same reference pipeline as agents: pass a `tool()` result directly in any agent or node `tools` array and `graph()` collapses it to its serializable `{ type: 'custom', name }` source while `run()` registers the implementation on the runner automatically (`toolsForGraph` exposes the stash). Name strings still work everywhere and remain the form serialized graphs carry; raw-API callers keep passing implementations via the runner's `tools` option, and every authoring boundary (`createGraph`, `registry.register`) now also accepts a `defineTool()` result, collapsing it to its name reference.

  Additive — the raw `createGraph`/`GraphRunner`/registry API is unchanged. The `research-and-write` example is rewritten with the facade (~110 lines of setup → ~20).

- c069711: Rename the `*Fn` runner options to noun-verb names: `persistState`, `loadGraph`, and `persistDelta` are now the primary `GraphRunnerOptions` fields. The former `persistStateFn` / `loadGraphFn` / `persistDeltaFn` remain as deprecated aliases (the primary name wins when both are given) and will be removed in a later release. `createFencedRunnerOptions` in `@cycgraph/orchestrator-postgres` now returns `persistState`; the worker accepts either spelling from `runnerOptionsFactory` results, so existing factories keep working.
- c069711: Remove the vestigial `map` edge-condition type. Map-reduce fan-out was never edge-driven: a `map` node names its worker in `map_reduce_config.worker_node_id` and invokes it directly, the worker needs no inbound edge, and the validator already treats config-referenced workers as reachable. A `map` edge merely evaluated like `always` (or like `conditional` when given an expression), so the type was a misleading synonym with no behavior of its own.

  `EdgeConditionSchema.type` is now `'always' | 'conditional'`. The condition evaluator, graph validator, and architect schema no longer accept `map`.

  **Migration:** replace `condition: { type: 'map' }` with `{ type: 'always' }` (or simply omit `condition` — `always` is the default), and `{ type: 'map', condition: expr }` with `{ type: 'conditional', condition: expr }`. Behavior is identical. A persisted graph carrying a `map` edge now fails schema validation on load with a clear error naming the edge, rather than routing under an alias.

- c069711: Run-scoped agent factory: the agent registry and provider registry can now be scoped into a run via `GraphRunnerOptions`, removing the process-global multi-tenant footgun.

  - New `GraphRunnerOptions.registry` and `GraphRunnerOptions.providers`. When either is set, the runner builds a run-scoped agent factory, so two concurrent runs with different registries (even reusing an agent id) never contaminate each other. Without them, the runner falls back to the process-global factory (unchanged behavior). When only one is set, the other half is inherited from the global factory, so scoping providers alone doesn't drop a globally-configured registry. A scoped factory always fails closed on unknown agent ids.
  - Subgraph child runners inherit the parent's scoped `registry`/`providers` and its `tools` option, so a scoped run stays scoped through nested graphs (and subgraph agents keep their tool resolution).
  - The authoring facade's `run()` now uses the scoped path — no process-global mutation — so concurrent facade runs are isolated by construction.
  - `configureAgentFactory` and `configureProviderRegistry` are **deprecated** (still functional). They mutate process-global state shared across every run in the process. Prefer scoping via `GraphRunnerOptions`. They will be removed once consumers have migrated.
  - The agent factory no longer rejects non-UUID agent ids up front; the registry owns id-shape constraints. The Postgres adapter treats a non-UUID id as clean not-found across the board (the `agents.id` column is `uuid`): `loadAgent` returns `null`, `updateAgent` no-ops, and `deleteAgent` returns `false`, instead of surfacing a Postgres type error. This lets human-readable ids (e.g. from the authoring facade) resolve against an in-memory registry.

  **Migration (mc-ai-api and other consumers):** replace startup `configureAgentFactory(registry)` / `configureProviderRegistry(providers)` with per-run options: `new GraphRunner(graph, state, { registry, providers, ... })` (or, for the worker, add them to the `runnerOptionsFactory` result). The global helpers keep working during the transition, so this can be done incrementally. Scoping per run is what makes a multi-tenant worker safe — a process-global factory shared across tenants is the contamination risk this change removes.

- c069711: Supervisors derive their read grants from their team. A `supervisor` node with no declared `read_keys` now sees `goal`, `constraints`, and everything its `managed_nodes` write (their `write_keys` plus each node's `${id}_output` fallback) — instead of routing blind on `goal`/`constraints` alone. This removes the `reads: ['*']` boilerplate every supervisor example hand-wrote, and it is least-privilege where the wildcard was not: tainted memory outside the team's outputs never reaches the routing prompt. Explicit `read_keys` on a supervisor override the derivation entirely, and non-supervisor nodes are unchanged. Together with the already-implied `handoff`/`set_status` write permissions, a typical supervisor now declares no grants at all.

  The security policy gate evaluates the same derived grants: a `securityPolicy` sees a grant-less supervisor's derived reads in `tainted_read_keys`, so tainted managed-node output cannot reach the routing prompt unexamined.

## 0.10.0

### Minor Changes

- fdf9705: Custom tool layer: `defineTool()` + a single `tools` runner option.

  - New `defineTool({ name, description, parameters, execute, taints?, timeoutMs? })` helper: Zod-validated arguments on every call, per-call timeout (30s default), eager spec validation, and opt-in taint tracking (`taints: true` records results in `state.taint_registry` with the new `custom_tool` source).
  - New `{ type: 'custom', name }` tool-source variant, plus authoring sugar everywhere tools are declared: bare names (`'save_to_memory'`, `'lookup_order'`) and `{ mcp: id, tools: [...] }` server refs normalize to the structured wire form at authoring boundaries, so stored graphs and agent configs never carry the sugar.
  - BREAKING: `GraphRunnerOptions.toolResolver` is replaced by `tools?: Array<DefinedTool | ToolResolver>` — one option for everything that provides tools. Migration is mechanical: `toolResolver: manager` → `tools: [manager]`. Resolution precedence is built-ins → defined tools → resolvers; unresolvable custom names and MCP sources without a resolver fail the preflight wiring check.
  - Built-in tool definitions consolidated into a single catalog (`save_to_memory` no longer duplicated across the connection manager and fallback resolver).
  - `@cycgraph/orchestrator-postgres`: the agent registry normalizes tool-source sugar at register/update, so persisted rows always store the structured wire form.

## 0.9.0

### Minor Changes

- c5b4a94: Agent registry permissions become an optional ceiling (ADR 001). The graph node's `read_keys`/`write_keys` are now the authoritative grant; a registry entry's `permissions` block, when present, is a hard cap intersected with the grant (`intersectWriteGrant()`, `'*'` on either side defers to the other). A registry entry without a `permissions` block is uncapped — the node's grant alone governs — while an explicit empty block still means deny-all. The agent executor validates writes and routes text output against the effective (intersected) permission, which also fixes a silent output drop when a broadly-registered agent ran on a narrowly-granted node, and applies a declared read ceiling as a narrowing filter over the node-sliced state view. Breaking: `AgentConfigSchema.read_keys`/`write_keys` are now optional (`undefined` = uncapped), and `permissions: null` registry entries change meaning from deny-all to uncapped; hosts relying on null-as-deny-all should register explicit empty permission lists.
- c5b4a94: Write permissions are now partially derived instead of fully hand-written. Node types imply their control-flow grants (supervisor: `handoff` + completion, approval/subgraph: HITL pause, swarm-config agents: peer handoff), and executor-owned result keys are implied by node config (verifier result pair, reflection envelope, tool `${id}_result`, map/voting/evolution aggregates). The `control_flow`/`status` pseudo-keys and result keys no longer need to appear in `write_keys` — declared keys remain the authority for what the node's agent writes, and redundant declarations stay valid. The derivation is exported as `effectiveWriteKeys()` / `impliedActionPermissions()` / `impliedResultKeys()`. `validateGraph` gains a dangling-read warning for `read_keys` entries nothing in the graph can produce, and drops the now-obsolete errors requiring pseudo-keys and result keys in `write_keys`.
- c5b4a94: State schema v2: engine-owned data moves out of the memory blackboard into first-class `WorkflowState` fields (`taint_registry`, `lesson_provenance`, `pending_approval`, `policy_approvals`, `subgraph_checkpoints`, `subgraph_stack`, `swarm_handoff_count`). Persisted v1 snapshots migrate automatically on load via `hydrateWorkflowState`. Reducers route the wire-format `_taint_registry` / `_lesson_provenance` payload keys to the new fields through a single choke point and drop unknown `_`-prefixed memory keys fail-closed (recorded in `memory_drops` with reason `reserved_key`).

  Compound-pattern executors (map, voting, evolution, annealing, swarm) now deliver per-invocation inputs through a new `StateView.taskContext` channel, rendered into prompts as a `## Task Context` section. This fixes a latent bug where the old `_`-prefixed context keys were stripped from prompts by injection sanitization, so workers never saw their map item, evolution candidates never saw their parent or its critique, and annealing feedback never reached the LLM.

  Breaking API changes: taint utilities are now registry-centric (`getTaintRegistry(state)`, pure `markTainted(registry, key, meta)`, `propagateDerivedTaint(memory, registry, outputKeys, agentId)`); HITL consumers read `state.pending_approval` instead of `memory._pending_approval`; swarm agents delegate via the writable `peer_delegation` memory key (the old `_peer_delegation` was unwritable by real agents) and swarm nodes require `control_flow` in `write_keys`.

## 0.8.0

### Minor Changes

- 0039e2a: Prompt construction passes the sanitized workflow goal to the context compressor as `options.query`. `ContextCompressor` options gain an optional `query` field; agent and supervisor prompts both supply it. Compressors that forward it to `@cycgraph/context-engine`'s `compress()` get relevance-aware allocation — budget concentrates on goal-relevant memory (measured on HotpotQA at a 0.3 compression target: retains 67/82 answerable questions vs 51/82 for LLMLingua-2 and 47/82 for query-agnostic compression). Compressors that ignore the new option behave exactly as before.

## 0.7.0

### Minor Changes

- b69cb1f: Documentation overhaul: package READMEs audited against source and brought back in sync with the shipping API.

  - **orchestrator-postgres**: README examples rewritten against the current API — adapter constructors no longer show the removed `{ db }` option (module-level `getDb()` singleton), `saveUsageRecord` replaces the nonexistent `usageRecorder.record()`, bulk `archiveCompletedWorkflows()`/`deleteWarmData()`/`getStorageStats()` replace the nonexistent per-run `archiveRun()`, `dequeue(workerId)` signature corrected, `getInjectedFactIds` now imported from `@cycgraph/orchestrator` (not `@cycgraph/memory`), and `DrizzleMCPServerRegistry` documented.
  - **context-engine**: README now lists the real pipeline presets (`fast` / `balanced` / `maximum`) and real stage options (`threshold`, `forceShape`, `truncationSuffix`); fixed a syntax error in the `contextCompressor` example.
  - **memory**: fixed a syntax error in the `retrieveMemory` example; gate-simulator timing claim aligned with measured behavior.
  - **orchestrator**: Subgraph pattern link retargeted to an existing docs page; `evolution-regex` added to the examples index; canonical registration examples use the camelCase authoring API.

## 0.6.0

### Minor Changes

- 8c0ed4b: Secure-by-default, budget/termination, durability, and API-surface hardening.

  **Secure by default.** Several guardrails that only held if the host wired an optional hook now fail safe out of the box:

  - **Architect publishing fails closed.** `architect_publish_workflow` is agent-reachable; publishing is now **denied** when neither `ArchitectToolDeps.canPublish` nor the new explicit `allowUnguardedPublish` opt-out is set, so a prompt-injected agent on an unconfigured host can't publish executable graphs. **BREAKING (behavior):** hosts that relied on unguarded publishing must set `allowUnguardedPublish: true` (trusted/local) or wire `canPublish`.
  - **stdio MCP env is scrubbed.** Registry-supplied env is stripped of loader/interpreter-hijack vars (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHON*`, `BROWSER`) before spawn — the command allowlist only constrains the binary, not what it loads at startup.
  - **Connect-time SSRF re-check.** http/sse MCP hosts are DNS-resolved at connect time and rejected if any address is private/loopback/metadata (defeating static DNS-rebinding), fail closed on lookup error, honoring the existing `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS` escape hatch. `isPrivateOrLoopbackHost` is now exported.
  - **Tool errors are tainted.** A throwing MCP server's (attacker-influencable) error text now mints a taint entry just like a successful result, so `strict_taint` / security-policy gates fire on injection delivered through a tool error.

  **Budget & termination.**

  - **A node-level timeout no longer aborts the whole run.** Each node gets its own `AbortController`; a node timeout cancels only that node's in-flight work instead of the single shared workflow controller (which poisoned parallel siblings and irreversibly tripped the run loop).
  - **Subgraph spend counts against the parent USD budget.** The child now inherits the parent's remaining `budget_usd`, and the subgraph action reports the child's already-summed cost via a new optional `token_usage.costUsd` (correct for multi-model children) that the parent adds directly and checks against `budget_usd`.
  - **Map fan-out is bounded.** A `max_items` cap (default and hard ceiling `MAX_MAP_ITEMS = 1000`) fails a map node loudly when the resolved item count exceeds it, instead of issuing an unbounded number of LLM calls. Never silently truncates.

  **Durability & queue.**

  - **Queue lifecycle ops verify ownership.** `WorkflowQueue.ack`/`nack`/`heartbeat`/`release` take an optional `workerId`; when supplied, the op only applies if the worker still owns the job, so a stale/reclaimed worker can't ack/nack/heartbeat a run a new claimant owns. Additive (omitting `workerId` keeps the prior behavior).
  - **Retry backoff.** A `nack`ed job now backs off (`visible_at = now + min(base·2^(attempt-1), cap)`) and `dequeue` skips not-yet-visible jobs, so a fast-failing job no longer burns its attempts in a tight loop. Configurable via a `WorkflowQueueOptions` constructor arg (`retryBackoffMs`, default 1000; `retryBackoffMaxMs`, default 5 min; `0` = immediate). **BREAKING (behavior):** retries are now delayed by default.
  - **Poison-pill jobs dead-letter.** `InMemoryWorkflowQueue.reclaimExpired` applies the same `attempt >= max_attempts` check `nack` uses, so a job whose worker dies hard (no `nack`) is dead-lettered after `max_attempts` instead of being reclaimed forever.
  - **Event-log gap no longer discards a recoverable run.** When replay-based recovery hits a sequence gap, the worker falls back to a valid state snapshot (authoritative on its own) instead of letting the corruption error dead-letter the job.

  **API surface & packaging.**

  - **`CycgraphError` base class.** All engine error classes now extend a shared, exported `CycgraphError`, so consumers can catch engine errors as a group (`catch (e) { if (e instanceof CycgraphError) … }`).
  - **Public barrels are curated.** The `types` / `persistence` / `evals` barrels are now explicit named re-exports instead of `export *`, so a new symbol in a leaf file no longer auto-enters the semver surface. The current public surface is unchanged.
  - **Dropped the unused `@ai-sdk/provider` direct dependency** (never imported in source), removing orchestrator's contribution to a duplicate-provider-version resolution.

## 0.5.0

### Minor Changes

- c6cb931: Security and robustness hardening across the engine. Several fixes restore guarantees that were advertised but not actually enforced.

  **Taint tracking.**

  - Fan-out executors (`map` / `voting` / `evolution`) now re-surface worker taint onto their aggregate output keys (`${node}_results` / `_consensus` / `_winner`). Previously tainted MCP output from a worker branch landed in the parent state **unmarked**, so downstream routing/gating couldn't see it — the taint control silently failed for every fan-out workflow. New `aggregateParallelTaint` helper mirrors the subgraph executor's child→parent carry-back.
  - `graph.strict_taint` is now actually enforced: it is threaded from the runner into `getNextNode` → `evaluateCondition`, so a `true` value rejects edge conditions that reference tainted memory keys. It was previously defined and documented but never wired in (a no-op). The tainted-key match is also boundary-aware now, so a short tainted key (e.g. `e`) no longer matches every expression.

  **Budget & recovery.**

  - `total_tokens_used` is no longer double-counted for `map`/`voting`/`evolution` nodes — the reducer stopped adding tokens that the runner's `_track_tokens` already accounts for. The token budget was previously tripping at half the real budget for fan-out-heavy graphs.
  - Crash recovery from the event log (no checkpoint) now restores the run's limits (`max_token_budget`, `max_iterations`, `max_execution_time_ms`, `goal`, `constraints`) from a new `config` payload on the `workflow_started` event, instead of silently resuming with defaults (no budget, `max_iterations` 50). Replay-safe and additive; older logs fall back to the previous defaults.

  **Hardening.**

  - SSRF guard on MCP transport URLs now canonicalizes the host before the private-range check, so decimal (`http://2130706433/`), hex, octal, short-form (`127.1`), and IPv4-mapped-IPv6 encodings of loopback/metadata addresses can no longer bypass it.
  - MCP tool results are capped at 10 MB; an oversized (or unserializable) result is replaced with a small error marker instead of being held in memory, fed into the LLM context, and copied into the event log (worker OOM protection).
  - Graph schema numerics/arrays are bounded: `FailurePolicy.max_retries` is now `int [0, 10]` (each retry is an LLM call — an unbounded value was the sharpest cost-exhaustion lever), backoffs / circuit-breaker thresholds / timeouts are capped, and `nodes`/`edges`/`read_keys`/`write_keys`/`max_handoffs` have upper bounds. **Note:** graphs that previously set `max_retries` above 10 or to a non-integer will now fail validation.
  - Cost estimation coerces token counts to finite, non-negative values, so a `NaN` from malformed provider usage can no longer produce a `NaN` cost that permanently disables the USD budget.
  - ReDoS mitigation on the runtime verifier's `matches` op (and the eval `regex` assertion): the pattern length is bounded, nested-quantifier patterns (`(a+)+` …) are refused, and the matched value is length-capped.
  - MCP tool resolution warns when a source omits `tool_names` (granting every server tool) and uses `hasOwnProperty` instead of `in` for the allowlist check (so `tool_names: ["toString"]` can't match a prototype member).
  - The JSON-Schema→Zod converter for MCP tool manifests bounds recursion depth (32) and per-object property count (1000).
  - The graph validator now warns on `write_keys: ['*']`, symmetric to the existing wildcard-read warning.

- c6cb931: Packaging: shared libraries moved to peer dependencies, and the Node engine floor lowered to 22.

  **BREAKING — install-time.** Libraries that a consumer composes against the packages' own objects are now `peerDependencies` and must be installed by the consumer:

  - `zod` (`@cycgraph/orchestrator`, `@cycgraph/memory`, `@cycgraph/context-engine`) — these packages export Zod schemas that consumers parse with and compose into their own schemas.
  - `ai` (`@cycgraph/orchestrator`) — the package exports `LanguageModel` types from the AI SDK.
  - `drizzle-orm` (`@cycgraph/orchestrator-postgres`) — the package exports Drizzle table objects (`export * from './schema'`) that consumers query with their own Drizzle operators (`eq`, `sql`, …). Drizzle tags tables/columns with internal Symbols, so two copies at different versions break at runtime; a single shared copy is required.

  Most consumers already depend on these directly, so no change is needed. A consumer that relied on them being installed transitively must now add them to its own `dependencies`.

  **OpenTelemetry is now optional.** `@opentelemetry/api` remains a dependency (it no-ops without an SDK), but the heavy `@opentelemetry/sdk-node`, exporters, `sdk-metrics`, `resources`, and `semantic-conventions` are now **optional** peer dependencies. Tracing/metrics are already loaded via dynamic `import()` only when enabled, so a deployment that doesn't export telemetry no longer installs the full OTel stack. Install them to enable trace/metric export.

  **Node `engines` floor lowered from `>=24` to `>=22`.** The packages run on Node 22 LTS (the whole test suite runs on it), so this only widens compatibility — Node 22 consumers no longer get `EBADENGINE` warnings.

## 0.4.0

### Minor Changes

- 7632a73: Add `deleteGraph(graph_id): Promise<boolean>` to the persistence port. Removes a graph definition (tenant-scoped) and returns `true` when a row existed, `false` when it didn't — so callers can distinguish a delete from a no-op. Implemented on both the in-memory provider and `DrizzlePersistenceProvider` (a tenant-scoped `DELETE ... RETURNING`). Additive to the `PersistenceProvider` interface.
- 7632a73: Provider registry: support open-ended providers via an `allowUnknownModels` flag. Curated cloud providers (OpenAI, Anthropic) keep failing fast on an unregistered model id — a typo'd or decommissioned id throws with guidance to fix the agent config or call `addModel()`, rather than being silently substituted by the provider SDK. Providers whose model space is open-ended (e.g. Ollama, where model ids are arbitrary local tags) can register with `allowUnknownModels: true` to pass unknown ids through (with a warning) instead of throwing.
- 7632a73: Prompt-injection firewall: a taint-aware security policy enforced before nodes run, plus full taint propagation across retrieval and composition.

  **Security policy port (new).** A new injectable `securityPolicy` option on `GraphRunnerOptions` (same adapter pattern as `factSanitizer`/`memoryRetriever`: the engine owns the mechanism, the caller owns the policy). It is consulted BEFORE each node executes — but only for nodes that read tainted data — and returns one of four effects: `allow`, `monitor` (emit a `security:policy` event and continue), `block` (fail the run closed via `SecurityPolicyViolationError`), or `require_approval` (inject a `request_human_input` gate before the node runs; approve → the node runs, reject → the run cancels). Because enforcement is pre-execution, the guarantee is model-independent: a fully prompt-injected agent still cannot execute the gated action. New exports: `SecurityPolicy`, `SecurityPolicyContext`, `SecurityPolicyDecision`, `SecurityPolicyEffect`, `SecurityPolicyViolationError`, `readableTaintedKeys`. New runner event `security:policy` (one per non-`allow` decision, for durable audit).

  **Taint now propagates where it previously leaked.**

  - `createStateView` re-attaches the `_taint_registry` (filtered to the node's readable keys) so the agent executor's `propagateDerivedTaint` actually sees tainted inputs — derived-taint propagation was silently a no-op before. `sanitizeForPrompt` strips all `_`-prefixed system keys, so the taint registry stays executor-only and never reaches the model prompt.
  - Edge conditions can route on taint: `runner/conditions.ts` exposes top-level `tainted` (bool) and `tainted_keys` (array) to filtrex expressions.
  - New taint source `retrieval`: when a node's `memory_query.untrusted` is set (RAG over external/user documents), the agent's outputs are marked tainted so a poisoned document cannot drive a downstream sensitive action ungated. New optional `untrusted` field on `MemoryQuerySchema` (additive).
  - Subgraphs no longer launder taint: the subgraph executor carries taint across the input mapping (parent → child) and output mapping (child → parent).

  **HITL across composition.** The `securityPolicy` propagates into subgraph child runners, so a tainted→sensitive action inside a subgraph is gated too. A gated child surfaces as a parent pause: the subgraph executor stashes the child checkpoint and re-enters/resumes the child on approval. `RequestHumanInputPayloadSchema` gains an optional `memory_updates` field (additive — applied before `_pending_approval` so it cannot clobber it) used to stash that checkpoint.

  Replay-safe and additive: no `REPLAY_VERSION` bump, and graphs that declare no policy / no `memory_query.untrusted` are unaffected. Fixes an ordering bug where a gated END node completed instead of pausing.

### Patch Changes

- 7632a73: Initialize the `total_input_tokens` / `total_output_tokens` split fields to `0` when constructing workflow state on crash recovery (`runner/recover.ts`) and in the eval runner. Without this, recovered and eval runs started with these counters undefined, so the input/output token breakdown could read as missing rather than zero. Aggregate `total_tokens_used` was unaffected.

## 0.3.0

### Minor Changes

- 65a822b: Supervisor-node lesson provenance. Closes the v1 gap where facts retrieved into a supervisor's routing prompt left no trace in `memory._lesson_provenance`, so supervisor-driven retrieval could never be attributed to a run's outcome (eval-gated learning silently ignored it). Supervisor nodes now mint a provenance entry for the injected facts at action-creation time and carry it on the `handoff` / `set_status` action they emit; `handoffReducer` / `setStatusReducer` merge it into the registry append-only with the same anti-clearing + ring-buffer-trim discipline `mergeMemory` applies to `update_memory` actions. `getInjectedFactIds(finalState)` now includes supervisor-injected facts, so the whole graph — agent, voting, evolution, and supervisor nodes — is uniformly attributable.

  Replay-safe (entries minted in the persisted action payload, reducer is pure; existing logs lacking the field are unchanged, so no `REPLAY_VERSION` bump). Only facts whose retriever supplied an `id` are recorded, matching the agent-node contract. New schema fields: optional `lesson_provenance` on `HandoffPayloadSchema` and `SetStatusPayloadSchema` (additive — non-supervisor emitters omit it).

## 0.2.0

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

- 8f211cc: Eval-gated learning ("verified lessons"): lessons are now retained only if runs that used them verifiably score better.

  **@cycgraph/orchestrator — lesson provenance.** Retrieved memory facts can carry an `id` (`MemoryRetrievalResult.facts[].id`, optional and non-breaking). When present, the runner records which facts were injected into each node's prompt in an append-only `memory._lesson_provenance` registry (same replay-safe pattern as the taint registry; invisible to node StateViews). Voting and evolution forward provenance from every sub-agent — losing candidates count as trials too. New exports: `getInjectedFactIds(state)`, `getLessonProvenance(state)`, `getLessonProvenanceRegistry(memory)`, plus the `LessonProvenanceEntry` / `LessonProvenanceRegistry` types. Known v1 limitation: supervisor-node retrieval is not provenance-tracked.

  **@cycgraph/memory — outcome ledger, retention gate, gated retrieval.** New `OutcomeLedger` interface + `InMemoryOutcomeLedger` (`recordOutcome({ run_id, score, fact_ids })`, per-fact trial stats, leave-one-out baselines). New `evaluateRetention(store, ledger, policy)` promotes `candidate`-tagged lessons that lift outcomes past `promote_margin` (tag rewritten to `verified`), soft-evicts harmful ones (`invalidated_by: 'eval-gate:harmful'`), and retires no-lift candidates at `max_trials` — including ones deadlocked on an empty leave-one-out baseline. New `retrieveGatedLessons(store, options)` fills the prompt budget verified-first with candidate exploration slots, selected in-progress-first via the ledger, with a `rest_after_trials` bench phase so fully-trialled candidates create the absence runs their baseline needs.

  Runnable adversarial demo at `packages/evals/examples/eval-gated-learning/`: three deliberately poisoned lessons crater a run and the gate evicts all three on outcome evidence alone, two runs after injection.

- 027be81: Fix: `evolution_config.elite_count` is now actually implemented (it was a no-op).

  The schema and validator advertised `elite_count` and rejected `elite_count >= population_size`, but the executor never used it — every generation was bred entirely from scratch, so the per-generation best fitness could dip when a noisy generation produced worse candidates than the last.

  Elitism now works as documented: the top `elite_count` candidates of each generation are carried forward **unchanged** into the next generation's pool — not re-generated and not re-scored. Two consequences:

  - **Monotonic fitness.** The best-so-far re-enters every subsequent pool, so the next generation's best is always ≥ the current one. `${node}_fitness_history` never dips. (Set `elite_count: 0` to opt out and restore the old all-fresh behavior.)
  - **Fewer LLM calls.** A carried elite occupies a population slot without a generation or evaluation call, so each generation after the first issues `population_size - elite_count` candidate calls instead of `population_size`.

  `elite_count` defaults to `1`, so this changes default evolution behavior. The carried candidate is tagged `is_elite: true` in the `${node}_population` summary. `elite_count` is internally clamped to `population_size - 1` so at least one fresh candidate is always generated.

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

- 131e3d3: Fail-loud / operational readiness (Phase 4): surface misconfigurations and dead-ends instead of silently producing wrong results.

  **Agent-not-found fails closed (BREAKING).** A typo'd or deleted `agent_id` against a configured registry previously fell back to a generic deny-all agent — the workflow ran to "completed" with garbage output and real token spend, no error. `loadAgent` now throws `AgentNotFoundError` for a configured-but-missing agent. The no-registry "lightweight dev" mode still falls back (it warns on every call). Opt back into the old behavior with `configureAgentFactory(registry, { allowDefaultFallback: true })` (tests/dev only).

  **Pre-flight wiring checks.** Before any node runs, the runner now validates that the injected dependencies match the graph: a `reflection` node requires `memoryWriter`, and a node declaring MCP tool sources requires `toolResolver` — both fail the run immediately with a clear message instead of mid-run after upstream nodes already spent tokens (and, for reflection, being pointlessly retried). A node with `memory_query` but no `memoryRetriever` logs a warning.

  **Routing dead-ends fail loud.** A node that is not a declared end node yet has no matching outgoing edge (e.g. a typo'd filtrex condition that evaluates false) previously dispatched `_complete` — a "successful" run that executed only part of the graph. It now fails with the new `NoMatchingEdgeError`. Set `GraphRunnerOptions.allow_implicit_completion = true` for the legacy silent-completion behavior.

  **Retriable-vs-permanent error classification.** The agent executor now reads the Vercel AI SDK's `APICallError.isRetryable` and tags `AgentExecutionError.retryable`. The retry loop short-circuits a definitively non-retryable error (400 invalid-request, context-length-exceeded, 401/403/404) instead of re-issuing it `max_retries` times. The supervisor's `generateText` call is wrapped in the same typed handling (previously propagated raw).

  **Observability: run_id on logs + workflow.run span.** `run()` now executes inside `runWithContext({ run_id, graph_id })` and the per-node chokepoint re-establishes it, so every downstream log line (agent executor, MCP, provider, persistence) carries `run_id`/`graph_id` for correlation — including under `stream()`. A `workflow.run` root span wraps the run, and `node.execute.{type}` spans now fire on both the streaming and non-streaming paths (the streaming path previously had none).

  New exports: `NoMatchingEdgeError`, `GraphRunnerOptions.allow_implicit_completion`, `configureAgentFactory(registry, { allowDefaultFallback })`.

- d3641f2: Guardrails: per-node resource cap + reflection fact sanitizer.

  **Per-node `budget`** — new optional `budget: { max_tokens?, max_cost_usd? }` field on every node. Enforced after each successful execution; breaching either cap throws the new `NodeBudgetExceededError` (barrel-exported) and stops the workflow immediately. Stops a runaway annealing loop or oversized reflection extraction from eating the entire workflow budget. Independent from `state.budget_usd` / `state.max_token_budget`, which keep guarding the run as a whole.

  **`factSanitizer` on `GraphRunnerOptions`** — new optional pre-write hook applied to every fact emitted by a `reflection` node before it reaches `memoryWriter`. Returning `null` drops the fact; returning a modified fact substitutes it. Used for PII redaction, policy filtering, content moderation at the memory-write boundary. Errors thrown by the sanitizer are logged (`fact_sanitizer_failed`) and the original fact passes through — a downed PII service must not block compound learning. New type barrel-exported: `FactSanitizer`.

- 131e3d3: Performance & scale (Phase 5): cut the cost of the hot paths and add the knobs to keep a long/large run bounded.

  **Tag-filtered fact retrieval is now an index lookup, not a table scan.** `FactFilter` gained a `tags` field; the hierarchical retriever pushes the reflection-loop's tag filter into the store instead of paging the whole table and filtering client-side. The Postgres store resolves it via `tags ?| array[...]` backed by a new GIN index on `memory_facts.tags` (migration `0015`) and now applies a deterministic `ORDER BY valid_from DESC, id` so `LIMIT/OFFSET` pagination is stable. The in-memory store honors the same `tags` filter (insertion-ordered, already stable). **Run `0015_add_memory_facts_tags_gin` before relying on tag retrieval at scale** — on a large live table prefer `CREATE INDEX CONCURRENTLY` out-of-band.

  **Evolution scores candidates in parallel** (bounded by the existing `max_concurrency`) instead of one evaluator call at a time — a generation now takes ~one evaluation's wall-clock, not N. It also stores per-candidate fitness **summaries** in `${node}_population` (index/fitness/reasoning) rather than every candidate's full output (the winner's full output already lives in `${node}_winner`), shrinking state and every checkpoint.

  **Memory retrieval is bounded and batched.** `extractSubgraph` gained a `max_entities` cap (default `DEFAULT_MAX_SUBGRAPH_ENTITIES = 500`) so a dense graph can't expand the BFS frontier near-exponentially, and it batch-fetches visited entities (`getEntities`) instead of one round-trip each.

  **Sanitize-after-truncate in prompt building.** Injection-sanitization is now the **last** transformation before memory/retrieved-memory is embedded — applied to exactly the bytes that reach the prompt (and to compressor output, which is now also byte-capped). Closes the window where truncating after sanitizing could leave a partial boundary artifact, and stops wasting sanitization on bytes that get dropped.

  **Delta tracker no longer loses patches on a failed persist.** `computeDelta` advances its baseline optimistically but stashes the prior baseline; the persistence coordinator calls the new `rollback()` if the write throws, so the next delta diffs against the last _durably persisted_ state (no lost changes, no skipped version numbers).

  **Auto-compaction is on by default.** `GraphRunnerOptions.compaction_interval` now defaults to `DEFAULT_COMPACTION_INTERVAL = 1000` (was `0`/disabled) when an `eventLog` is wired, so a long run can't grow the event log without bound. Compaction is recovery-safe (checkpoint + `loadEventsAfter`). Set `compaction_interval: 0` to retain full history and compact manually. The snapshot-resume idempotency rebuild is now checkpoint-aware — it loads only the tail after the latest checkpoint instead of the entire event history.

  **New `RateLimiter` port.** Inject `GraphRunnerOptions.rateLimiter` to pace LLM calls inside a provider's budget — awaited before every agent/supervisor/evaluator call at a single chokepoint (the implementation may delay to throttle or throw to reject; abortable; propagated into subgraphs). New exports: `RateLimiter`, `RateLimitRequest`, `RateLimitCallKind`.

  **Per-server MCP concurrency limit.** `MCPConnectionManager` accepts `default_max_concurrent_calls`, and `MCPServerEntry` gained `max_concurrent_calls`, bounding in-flight tool calls per server (via a FIFO semaphore) so a wide fan-out can't overwhelm one MCP server. Defaults to unlimited for compatibility.

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

- 131e3d3: Security hardening (Phase 2): close the gaps between the documented security model and what the code enforced.

  **Architect publish is validated and gateable.** `architect_publish_workflow` now runs `GraphSchema.parse` + `validateGraph` before persisting — a prompt-injected or buggy agent can no longer publish an unvalidated executable graph (wildcard reads, unbounded fan-out, arbitrary tool wiring). New optional `ArchitectToolDeps.canPublish` gate lets the host require human approval / a privileged credential before any publish.

  **MCP registry is re-validated at the trust boundary + SSRF guard.** Both `InMemoryMCPServerRegistry` and `DrizzleMCPServerRegistry` now `MCPServerEntrySchema.parse` on save AND load — the stdio command allowlist and URL checks are enforced for real, not just at compile time, closing a host-RCE path. Transport URLs (http/sse) are blocked from pointing at private / loopback / link-local / cloud-metadata addresses (SSRF). Escape hatch for local dev: `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true`.

  **Taint tracking holes fixed.** (1) Standalone `tool` nodes now taint their MCP output — previously external data was written to memory untainted, defeating taint-aware routing. (2) Concurrent executions (voting/evolution/map) no longer cross-attribute taint: each `resolveTools()` gets its own collector, drained via `drainTaintEntries(tools)`. (3) `_taint_registry` is now append-only through reducers — a crafted `update_memory: { _taint_registry: {} }` can no longer clear taint to launder untrusted data as trusted.

  **`read_keys` defaults to least privilege (BREAKING).** Node `read_keys` now defaults to `[]` instead of `['*']`. A node sees only `goal`/`constraints` plus the memory keys it explicitly lists — state slicing is on by default. Nodes that read upstream outputs must declare them (e.g. `read_keys: ['research_notes']`). `validateGraph` warns on any node using `['*']`. The architect prompt/schema emit explicit, scoped keys.

  **Resource bounds (DoS guards).** Added upper bounds to every fan-out/iteration knob: `population_size` ≤ 100, `max_generations` ≤ 100, `max_concurrency` ≤ 50, `voter_agent_ids` ≤ 50, supervisor/annealing `max_iterations` ≤ 1000. Subgraph nesting is capped at depth 32 (a chain of distinct subgraphs previously recursed to OOM), and subgraphs now inherit the parent's guardrails (toolResolver, factSanitizer, memoryWriter, modelResolver, etc.) instead of running with reduced guarantees.

  **Reflection facts are sanitized + fail-closed.** Fact content is injection-sanitized before persistence, closing a cross-run stored-injection channel (tainted content → distilled fact → retrieved into a future run's prompt). `factSanitizer` now FAILS CLOSED by default: a thrown sanitizer (downed PII service, buggy regex) drops the fact instead of persisting it unredacted. New `GraphRunnerOptions.factSanitizerFailMode: 'drop' | 'pass'` (default `'drop'`); set `'pass'` to restore the old fail-open behavior.

  New exports: `ArchitectToolDeps.canPublish`, `GraphRunnerOptions.factSanitizerFailMode`.

- First stable release — the "verified lessons" release. Workflows learn from every run (reflection → memory → retrieval), and lessons survive only if runs that used them verifiably scored better: lesson provenance in the runner, an outcome ledger, and a statistically-controlled retention gate (Welch inference, FDR control, sequential alpha-spending) with a shipping simulator to measure any policy's real detection and false-positive rates before trusting it. Guarded throughout by per-node budgets, taint tracking, least-privilege state slicing, and human-in-the-loop gates.

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

- 8f211cc: Migrate off Anthropic model IDs retiring 2026-06-15. `DEFAULT_AGENT_MODEL` is now `claude-sonnet-4-6` (was `claude-sonnet-4-20250514`); `ANTHROPIC_MODELS` gains `claude-opus-4-8` and `claude-sonnet-4-6` while keeping the deprecated IDs so existing persisted agent configs still validate; the pricing table gains `claude-opus-4-8` ($5/$25 per MTok) and keeps historical entries so cost replay of old runs stays correct. All examples, docs, and test fixtures updated to the new IDs.
- 5617568: Upgrade OpenTelemetry to the current line and drop the `protobufjs` override (resolves a moderate advisory).

  The OTLP-HTTP and Prometheus exporters were on `0.217.0` and pulled `protobufjs@8.0.x` transitively (via `@opentelemetry/otlp-transformer`). A repo-wide `protobufjs: ">=8.0.1"` override pinned it to `8.0.3` — which is inside the vulnerable range of GHSA-jggg-4jg4-v7c6 (DoS via recursive JSON descriptor expansion, `>=8.0.0 <8.2.0`).

  `@opentelemetry/otlp-transformer@0.219.0` no longer depends on `protobufjs` at all, so bumping the exporters removes that dependency edge. The only remaining `protobufjs` is `7.6.3` via `@grpc/proto-loader` (the gRPC log exporter bundled in `sdk-node`), which is outside the advisory range. With the override removed, `npm audit --omit=dev` reports 0 vulnerabilities.

  Bumped: `@opentelemetry/exporter-prometheus`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-node` `^0.217.0` → `^0.219.0`; `@opentelemetry/resources`, `@opentelemetry/sdk-metrics` `^2.7.1` → `^2.8.0`. Removed the `protobufjs` entry from the root `overrides`.

- 131e3d3: Test & CI hardening (Phase 7).

  **Fixed: the migration chain could never build the schema from scratch (orchestrator-postgres).** Two compounding gaps meant `npm run migrate` had never actually run end-to-end on a fresh database:

  1. A stray `drizzle` entry in `.gitignore` silently kept 14 of the 16 migration `.sql` files out of git, while `meta/_journal.json` (tracked) references all 16. Since the package publishes `drizzle/` and releases run from a clean checkout, a published build — or any CI/clone — had a journal pointing at absent files. The ignore rule now keeps `packages/orchestrator-postgres/drizzle/**`.

  2. The `@cycgraph/memory` tables (`memory_entities`, `memory_relationships`, `memory_episodes`, `memory_themes`, `memory_facts`, `memory_entity_facts`) were only ever created with `drizzle-kit push` and **never captured in a migration** — yet migration `0013` adds a column to `memory_facts` and `0015` indexes it. A from-scratch migrate therefore failed with `relation "memory_facts" does not exist`. Migration `0013` now creates the full memory schema (tables, FKs, indexes) before the `tags` ALTER, so the chain applies cleanly.

  Because the chain had never successfully applied anywhere (dev/prod used `push`), there is no migrated database for these changes to conflict with.

  **CI now runs the Postgres integration tests against a real database.** The `test-orchestrator-postgres` job gains a `pgvector/pgvector:pg16` service container, creates the `vector` extension (a `services:` container doesn't auto-run `init.sql`, and no migration creates it), applies migrations, and runs the suite **without** `--passWithNoTests`. The ~66 Drizzle adapter / durable-event-log / SKIP-LOCKED queue + fencing tests that were silently skipping now execute and must pass.

  **Coverage thresholds gate the orchestrator suite.** `vitest run --coverage` enforces a regression ratchet (global plus per-directory floors on `src/runner` and `src/agent`), scoped to `src/` so built/dist/scratch files don't skew the numbers. The CI orchestrator job runs with `--coverage` so a meaningful coverage drop fails the build.

  **New tests for previously-uncovered units:** the `verifier` node executor (all three variants — `llm_judge` / `expression` / `jsonpath` — plus assertion ops, `result_key`, and `throw_on_fail`), and a `computeMemoryDiff` apply round-trip suite.

## 0.1.0-beta.8

### Minor Changes

- 8f211cc: Eval-gated learning ("verified lessons"): lessons are now retained only if runs that used them verifiably score better.

  **@cycgraph/orchestrator — lesson provenance.** Retrieved memory facts can carry an `id` (`MemoryRetrievalResult.facts[].id`, optional and non-breaking). When present, the runner records which facts were injected into each node's prompt in an append-only `memory._lesson_provenance` registry (same replay-safe pattern as the taint registry; invisible to node StateViews). Voting and evolution forward provenance from every sub-agent — losing candidates count as trials too. New exports: `getInjectedFactIds(state)`, `getLessonProvenance(state)`, `getLessonProvenanceRegistry(memory)`, plus the `LessonProvenanceEntry` / `LessonProvenanceRegistry` types. Known v1 limitation: supervisor-node retrieval is not provenance-tracked.

  **@cycgraph/memory — outcome ledger, retention gate, gated retrieval.** New `OutcomeLedger` interface + `InMemoryOutcomeLedger` (`recordOutcome({ run_id, score, fact_ids })`, per-fact trial stats, leave-one-out baselines). New `evaluateRetention(store, ledger, policy)` promotes `candidate`-tagged lessons that lift outcomes past `promote_margin` (tag rewritten to `verified`), soft-evicts harmful ones (`invalidated_by: 'eval-gate:harmful'`), and retires no-lift candidates at `max_trials` — including ones deadlocked on an empty leave-one-out baseline. New `retrieveGatedLessons(store, options)` fills the prompt budget verified-first with candidate exploration slots, selected in-progress-first via the ledger, with a `rest_after_trials` bench phase so fully-trialled candidates create the absence runs their baseline needs.

  Runnable adversarial demo at `packages/evals/examples/eval-gated-learning/`: three deliberately poisoned lessons crater a run and the gate evicts all three on outcome evidence alone, two runs after injection.

### Patch Changes

- 8f211cc: Migrate off Anthropic model IDs retiring 2026-06-15. `DEFAULT_AGENT_MODEL` is now `claude-sonnet-4-6` (was `claude-sonnet-4-20250514`); `ANTHROPIC_MODELS` gains `claude-opus-4-8` and `claude-sonnet-4-6` while keeping the deprecated IDs so existing persisted agent configs still validate; the pricing table gains `claude-opus-4-8` ($5/$25 per MTok) and keeps historical entries so cost replay of old runs stays correct. All examples, docs, and test fixtures updated to the new IDs.

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
