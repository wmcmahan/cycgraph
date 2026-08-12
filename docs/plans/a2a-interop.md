# Plan: A2A interoperability

Status: proposed, not started. Raised 2026-08-12 while thinking about
subgraph composition as a route to a web of connected workflows.

## Why this is not "MCP for agents"

The reflex is to treat A2A the way we treated MCP: a provider you plug in
and forget. That reflex produces the wrong design.

MCP works as a provider integration because a tool is something an agent
calls mid-turn. It has no lifecycle of its own, no state, and it returns
before the turn ends. A remote A2A agent is none of those things. It is a
unit of work with its own lifecycle, which puts it next to our `subgraph`
node, not next to a tool.

The community `a2a-ai-provider` (0.5.0-alpha.1) makes exactly this mistake
in a way worth naming, because it is the obvious thing to reach for:

```javascript
const result = await generateText({ model: a2a('https://…/agent-card.json'), prompt });
```

Modelling a remote agent as a `LanguageModel` costs four things we care
about:

- **`input-required` has nowhere to go.** That state is how a remote agent
  asks a human a question. Through a model interface, remote HITL is gone.
- **Artifacts flatten to text.** Structured output becomes a string.
- **No resume handle.** Long-running tasks resume by `taskId`; a model call
  has none.
- **No seam.** It lands inside the agent executor, so there is no boundary
  at which to taint returning data or account for spend.

Build against `@a2a-js/sdk` (1.0.1, stable) instead of the alpha provider.
The provider is useful as a wire-format reference and nothing more.

## What A2A is and is not

Grounded in the v1 specification.

| | Provides | Does not provide |
|---|---|---|
| A2A | Transport, discovery via Agent Card, auth, async Task lifecycle, streaming, push notifications | Cost or token accounting, any notion of untrusted data, per-field schemas |
| cycgraph subgraph | Typed interface, isolated child state, budget and taint propagation, capability ceiling, HITL pause/resume, replayable event log | Anything across a process boundary |

Two consequences follow.

**Our interface is the stronger contract.** `AgentSkill` carries `id`,
`name`, `description`, `tags`, `examples`, `inputModes`, `outputModes`, and
`security`. There is no JSON Schema. Input and output handling rests on
MIME types, which describe modality rather than shape. Our graph `inputs` /
`outputs` declare per-key schemas and validate values in both directions.
When we call a remote agent, our declaration is the only real contract in
play, and it constrains only our side of the wire.

**Three of our guarantees stop at the boundary**, covered under Tensions.

## Two directions, and the order to build them

**Consuming**: an `a2a` node calls a remote agent, sibling to `subgraph`.
This is the smaller piece and the one that proves the lifecycle mapping.

**Serving**: a cycgraph graph is published *as* an A2A agent, with an Agent
Card and a task endpoint. This is the bigger unlock for a web of workflows,
because it makes a graph callable by anything that speaks the protocol, and
a bundle manifest is already most of an Agent Card. `@a2a-js/sdk` exposes a
`./server/express` entry point with `jsonRpcHandler` and `restHandler`, so
this is not a from-scratch protocol implementation — though express is a
PEER dependency there, alongside `@grpc/grpc-js`. Bringing a web framework
in is exactly why serving belongs in its own package rather than
orchestrator core.

Consuming first, because serving is easier to get right once we have lived
with the Task state machine from the client side.

## Consuming: an `a2a` node, built the way `subgraph` is built

A separate node type, mirroring subgraph's structure rather than reusing
its type. The two are siblings: both delegate a unit of work to something
opaque, map memory across a boundary, and can pause for a human. They
differ in where the work runs, and that difference is worth seeing in the
graph.

What "the same pattern" means concretely, piece by piece:

| `subgraph` has | `a2a` gets |
|---|---|
| `'subgraph'` in `NodeTypeSchema` | `'a2a'` |
| `subgraph_config` block | `a2a_config` block |
| `execution/nodes/subgraph.ts` executor | `execution/nodes/a2a.ts` |
| entry in the executor registry | same, compiler-enforced |
| `subgraph()` authoring primitive | `a2a()` authoring primitive |
| `inputs` / `outputs` mapping convention | identical |
| implied write grants from `output_mapping` | identical |
| checkpoint stash for a nested pause | same field, `taskId` instead of child state |

### The authoring primitive is the point

The thing that makes `subgraph` pleasant is not its node type, it is that
`subgraph(child, spec)` returns a node value with a typed spec. Nobody
writes `node({ type: 'subgraph', subgraphConfig: { … } })` by hand. `a2a`
should get the same treatment:

```typescript
a2a('research-service', {
  id: 'research',
  skill: 'deep-research',
  reads: ['topic'],
  writes: 'findings',
  inputs:  { topic: 'query' },      // parent key → message part
  outputs: { report: 'findings' },  // artifact name → parent key
  maxWaitMs: 120_000,
})
```

Same shape as `SubgraphSpec`, same mapping direction, same `reads`/`writes`
grants. A reader who knows one knows the other.

`subgraph()` carries an in-scope child `Graph` on a brand symbol so
`graph()` can collect it for `run()` to auto-wire. `a2a()` needs no
equivalent: a server id resolves through the registry at run time, so there
is nothing to collect and no closure to fold. That is a simplification, not
a gap.

### Config

```typescript
a2a_config: {
  server_id: string;            // resolved through the trusted registry
  skill_id?: string;            // which advertised skill to invoke
  input_mapping: Record<string, string>;   // parent key → message part
  output_mapping: Record<string, string>;  // artifact NAME → parent key
  max_wait_ms?: number;
}
```

`output_mapping` keys on `Artifact.name`, and that is a weaker contract
than the local case. An `Artifact` carries both `artifactId` (unique within
a task, but server-generated, so unknowable when authoring) and `name`
(documented only as "human readable"). Name is the only thing an author can
map against, and nothing guarantees stability across versions of the remote
agent. Say so in the docs rather than implying parity with graph output
keys.

Content is richer than text, which is worth knowing before designing the
mapping: a `Part` is a discriminated union over `text`, `raw` (bytes),
`url`, and `data` (arbitrary JSON), each carrying `mediaType`. Structured
results survive the boundary — they do not have to be flattened to a
string.

No `max_iterations`: iteration is the remote agent's business, and a
knob that silently does nothing is worse than an absent one.

Note what this avoids. Reusing the `subgraph` type would have required
turning `subgraph_id` into a discriminated target and migrating a persisted
schema, since a flat string cannot say whether it names a graph or a
server. A sibling node type needs none of that — `subgraph_config` is
untouched, and there is no migration to get wrong.

### Sharing the boundary logic, not the executor

The seam work is genuinely common: build input from the mapping, validate
against declared inputs, carry taint inward, map outputs back, validate,
taint outward, stash on pause. Extract those into a shared module that both
executors call, so interface validation and taint crossing cannot drift
between them.

Everything else differs enough that one executor serving both would be a
`switch` wearing a trench coat: local resolution through `loadGraph` versus
an Agent Card fetch, a nested `GraphRunner` versus a Task submission, child
state versus a `taskId`, failure policy versus network and auth errors.

### Why a distinct node type is the safer choice

I argued the opposite in an earlier draft, and was wrong.

A `subgraph` node propagates the parent's remaining budget and runs under
an enforced capability ceiling. An `a2a` node can do neither. If both wore
the same type, a reader would have to inspect config to know which
guarantees apply, and the validator would have to reason about a union to
warn about it.

As siblings, the type IS the disclosure. `type: 'a2a'` says "budget and
ceilings stop here" at a glance, the validator can warn unconditionally
when one appears in a budgeted graph, and the docs get one guarantees table
per node type instead of a hedged union.

### Lifecycle mapping

Taken from `TaskState` in `@a2a-js/sdk@1.0.1`, not from the spec prose.
There are **nine** members, two of which the earlier draft of this plan
missed, and both change the design.

| A2A `TaskState` | Kind | cycgraph |
|---|---|---|
| `SUBMITTED` / `WORKING` | active | node executing |
| `INPUT_REQUIRED` | interrupted | pause, reusing the approval / HITL machinery |
| `AUTH_REQUIRED` | interrupted | **not** a human pause — refresh credentials and resume |
| `COMPLETED` | terminal | `update_memory` from mapped artifacts |
| `FAILED` | terminal | node failure, through `failure_policy` |
| `REJECTED` | terminal | **non-retryable** failure |
| `CANCELED` | terminal | run cancellation |
| `UNSPECIFIED` / `UNRECOGNIZED` | — | treat as failure; do not assume forward compatibility |

`input-required` reusing the HITL path remains the load-bearing claim. A
remote agent asking a question should surface to the same human review the
approval node already drives, and a nested pause already has a checkpoint
stash to live in.

The two additions matter on their own terms:

**`REJECTED` must not retry.** The agent has decided not to do the work.
Running it through `failure_policy` burns the retry budget on a decision
that will not change — the same shape as the 401 that retried three times
before the executor learned to classify it. Mark it non-retryable at the
executor, the way `retryable === false` short-circuits today.

**`AUTH_REQUIRED` is an interrupted state, not a failure.** The SDK already
models the recovery: `AuthenticationHandler` supplies `headers()`,
`shouldRetryWithHeaders(req, res)` for 401/403, and `onSuccessfulRetry()`
to persist refreshed credentials. Wire the registry entry's credentials
through that handler and this resolves without human involvement. It is a
distinct resume path from `input-required` and should not be collapsed
into it.

### Server registry, not inline URLs

Remote endpoints belong in a trusted store, exactly like MCP servers. An
`a2a_servers` registry entry mirrors `MCPServerEntrySchema`:

- URL validated at every registry read and write, not only at call time.
- **Reuse `isPrivateOrLoopbackHost`** from `tools/schema.ts`. An Agent Card
  URL pointed at `169.254.169.254` is the same SSRF the MCP guard already
  exists to stop, and the same env escape hatch should apply for local
  development.
- Credentials live on the registry entry and are injected at call time.
  They never reach an agent, per the secrets mandate.
- `allowed_agents`, timeouts, and concurrency caps carry over unchanged.

## Tensions to settle before building

**Taint is mandatory, and this is the easy one.** Everything returning from
a remote agent is external data and must land in `state.taint_registry`.
The MCP tool path already does this; the `a2a` node is a new seam for
existing machinery.

**Budget stops at the boundary.** We cannot enforce a token budget on
someone else's infrastructure, and A2A carries no cost field. Options: cap
by attempts and wall-clock only; or define an optional cost extension and
accept that most servers will not populate it. The plan should state
plainly that remote spend is unmetered rather than pretend otherwise.

**Replay determinism breaks.** Our event-log replay assumes a node can be
re-executed or its result restored. Re-issuing a remote task is not replay,
it is a second side effect against someone else's system. Persist the
`taskId` and resume, which is precisely what `state.subgraph_checkpoints`
already does for a nested HITL pause. Same field or a sibling, same
pattern. This likely needs a `REPLAY_VERSION` bump.

**Capability ceilings do not apply outward.** A bundle's `requires` becomes
an enforced ceiling because we run the child. We cannot constrain what a
remote agent does. We can only constrain what we send it and how we treat
what comes back, and the docs should not blur that line.

These three are why `a2a` is a distinct node type rather than a `subgraph`
variant. The type is what makes the missing guarantees legible without
reading config.

## Serving: a graph as an A2A agent

Sketch only; design properly after consuming lands.

- Agent Card generated from the graph's declared interface plus bundle
  manifest identity. We have more information than the card can express,
  so the mapping is lossy in our favour.
- Each incoming Task starts a run; `taskId` maps to `run_id`.
- An approval pause reports as `input-required`, closing the loop
  symmetrically with the consuming side.
- Streaming maps onto the existing stream events.
- This is a new package or app rather than orchestrator core, since it
  needs an HTTP server and a web framework.

## Phases

**Phase 1 — client spike, no engine changes.** Partly done.

Types read from `@a2a-js/sdk@1.0.1` and folded in above: the nine-member
`TaskState`, the `Part` union, `Artifact` identity, `AgentSkill` (confirmed
to carry no JSON Schema), and the `AuthenticationHandler` contract. Client
surface is `sendMessage`, `sendMessageStream`, `getTask`, `cancelTask`,
`resubscribeTask`, plus push-notification config methods.

What types cannot answer, and still needs a live server: whether a real
agent drives `input-required` at all or just blocks, how faithfully
`REJECTED` is used versus `FAILED`, whether artifact names are stable
enough to map against, and what auth looks like in practice.

**Phase 2 — extract the shared boundary.** Pull mapping, interface
validation, taint crossing, and the checkpoint stash out of
`execution/nodes/subgraph.ts` into a module both executors will call. No
behaviour change, existing subgraph tests are the guard, and the golden
approach applies: prove it is a pure refactor before anything new lands on
top.

**Phase 3 — the registry.** `a2a_servers` entry schema with the SSRF guard
and credential handling. Independently testable, no node type yet.

**Phase 4 — the `a2a` node, terminal tasks only.** Node type, config block,
executor, and the `a2a()` authoring primitive. Submit, await completion,
map artifacts, taint them. Explicitly excludes `input-required`. The
smallest thing that runs end to end.

**Phase 5 — pause and resume.** `input-required` through the HITL path,
`taskId` in the checkpoint stash, `REPLAY_VERSION` bump.

**Phase 6 — serving.** Separate effort, own plan.

## Open questions

1. Does an `a2a` node get a declared interface of its own? The remote side
   cannot be validated against, but declaring what WE expect back gives the
   boundary check something to enforce and keeps the two node types
   symmetric.
2. Is `skill_id` required, or do we send a message and let the remote agent
   route? The card advertises skills, but nothing in the client surface
   takes a skill id — it is metadata for choosing an agent, not a
   parameter. So `skill_id` may be documentation on our node rather than
   anything on the wire. Confirm against a live server.
3. Do streaming updates surface as our stream events, or only the terminal
   result? `sendMessage` (await) and `sendMessageStream` (async generator)
   are both available, so Phase 4 can start with the former and add the
   latter without reshaping the executor.
4. Does `a2a()` accept a `GraphBundle`-style descriptor later, so a
   published Agent Card can be pinned the way a bundle pins an interface?
   Deferred until serving exists and there is something to pin.

## Why A2A lives outside core, and MCP does not

Worth recording, because the obvious justification is wrong.

"Core takes no transport dependency" is NOT a principle this repo follows.
`@ai-sdk/mcp` is a hard dependency of `@cycgraph/orchestrator`, and
`src/mcp/connection-manager.ts` is substantial protocol handling inside
core. A2A being outside is therefore an inconsistency, defensible on its
own merits rather than on a rule.

The merits:

- **Dependency weight.** `@a2a-js/sdk` brings `jose` and `uuid`, with peer
  deps on `@grpc/grpc-js`, `@bufbuild/protobuf`, and `express`.
  `@ai-sdk/mcp` is in the same family as `ai`, which core already depends on
  for the whole agent runtime, so it is marginal rather than additive.
- **Protocol maturity.** A2A v1.0 is months old; MCP has settled.
- **Measured payoff.** Of the four bugs the live harness found, three were
  in the ADAPTER (numeric enums, pending states, wire-format parts) and one
  in the engine. The adapter churned while the engine stayed still, which
  is the separation doing its job.

**Should MCP follow?** Not now. The two are not parallel: A2A is one node
type with a four-method surface, whereas MCP threads through agent config,
the tool resolver, capability ceilings, taint collection, per-tool
timeouts, circuit breakers, and the manifest cache. Extracting it is a
breaking change to the most-used integration path.

Two things would eventually justify it. Testability, since MCP logic
currently needs a real server to exercise. And per-request header control:
MCP trace propagation is impossible today precisely because the connection
manager caches a client with static headers, and a port would move that
decision to our side of the line.
