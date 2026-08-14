# Node authoring consistency

## Problem

`subgraph()` and `a2a()` are terse, subject-first helpers. The other eleven node
types go through generic `node()` with a nested config block. Authoring a graph
means switching between two shapes depending on which node you reach for.

```ts
// subgraph(): subject first, config flat, misuse unconstructible
subgraph(child, { id: 'research', inputs: { subject: 'topic' } })

// generic: type as a string, config nested one level down
node({
  id: 'sup',
  type: 'supervisor',
  agent: brain,
  supervisorConfig: { managedNodes: [research, write], maxIterations: 10 },
})
```

Three differences compound: the call shape, the config nesting, and the
vocabulary (`inputs` versus `inputMapping`).

### The safety gap

`NodeSpec` is a flat intersection of every config, not a union discriminated on
`type`. TypeScript accepts both of these:

```ts
node({ id: 'reflect', type: 'reflection', supervisorConfig: { … } })  // wrong config
node({ id: 'sup', type: 'supervisor' })                              // required config absent
```

Both fail at `validateGraph`, so this is a load-time error rather than a
correctness hole. A misspelled key such as `mapConfig` is caught at compile time
today, because it matches no field on any config. What is not caught is a real
config attached to the wrong type, or a required config left out entirely.

`subgraph()` and `a2a()` make both unconstructible. Extending that property is
the point of this work, and the terseness is a side effect.

## Decisions

Recorded 2026-08-13.

- **One helper per node type**, subject-first where the type has a natural
  subject, spec-only where it does not. This extends the pattern `subgraph()`
  and `a2a()` already ship rather than introducing a third one.
- **Additive.** `node()` stays as the escape hatch for dynamic and generated
  graphs, and for anything the helpers do not cover. Nothing breaks.

## The thirteen types

Requirements taken from `graph-validator.ts`, which is the authority on what
each type needs.

| Type | Required config | Natural subject |
| --- | --- | --- |
| `subgraph` | `subgraph_id` | child graph — **shipped** |
| `a2a` | `server_id` | server id — **shipped** |
| `agent` | `agent_id` | the agent — covered by `node({ agent })` |
| `tool` | `tool_id` | tool id |
| `supervisor` | config + `agent_id` | the routing agent |
| `map` | config + worker | the worker node |
| `voting` | config + `voter_agent_ids` | the voters |
| `evolution` | config | the candidate agent |
| `verifier` | config (3 variants) | varies by variant |
| `reflection` | config + `source_keys` | the source keys |
| `approval` | config | none |
| `router` | none | none |
| `synthesizer` | none | none |

Two types (`router`, `synthesizer`) have no validator case and no required
config. Three (`approval`, `router`, `synthesizer`) take a spec only.

### Agent modifiers are not node types

`swarm_config` and `annealing_config` are validated under `case 'agent'`. They
modify an agent node rather than naming a type of their own, so they do not get
helpers of the same kind. They belong on the agent node's spec:

```ts
node({ id: 'peer', agent: worker, swarm: { peers: [a, b], maxHandoffs: 5 } })
```

## Proposed surface

```ts
// delegation (shipped, unchanged)
subgraph(child, { id, reads, writes, inputs, outputs, maxIterations })
a2a(serverId, { id, reads, writes, skill, inputs, outputs, maxWaitMs })

// control flow — `writes` accepted: the node's agent authors the output
supervisor(brain, { id, manages, maxIterations, reads, writes, memoryQuery })
approval({ id, prompt, reviewKeys, timeoutMs, onReject, reads, writes })
router({ id, reads, writes })

// deterministic step — reads double as the tool's argument object
runTool(toolId, { id, reads })

// fan-out — result keys implied, no `writes`
mapReduce(worker, { id, items, into, concurrency, maxItems, onError })
voting(voters, { id, strategy, voteKey, quorum, judge, weights })
evolution(candidate, { id, evaluator, populationSize, maxGenerations, fitnessThreshold })
synthesizer(agent, { id, reads })

// quality — result keys implied
verifier.llmJudge(judge, { id, target, threshold, criteria })
verifier.expression(expr, { id, throwOnFail })
verifier.jsonPath(target, { id, path, assertion })

// memory — result key implied
reflection(sources, { id, extractor, tags, entityKeys, resultKey })
```

Every helper returns a `NodeValue`, so topology references keep working by
value: `edges: [{ from: research, to: verify }]`.

## Resolved

1. **The tool node stays, and gets a helper named `runTool`.** It is the
   deterministic-step primitive: no LLM, `toolDef.execute(stateView.memory)`,
   guaranteed to run. An agent's tool call needs a model to decide to make it
   and can be skipped. Fifty test usages and six in examples, mostly eval
   fixtures that need the guarantee.

   Named `runTool` rather than `toolCall` because `toolCalls` / `toolCallId`
   elsewhere in the engine mean model-emitted calls, which is the opposite of
   what this node does.

   Its `reads` slice becomes the tool's argument object, which is a sharp edge
   the helper should document at the call site.

2. **The fan-out over items is `mapReduce`, not `fanOut`.** Three node types
   fan out, differing in what they spread over: `mapReduce` over items,
   `voting` over voters, `evolution` over candidates. `fanOut` would claim the
   general term for one specific case. `mapReduce` matches the existing config
   name and the docs, and avoids the lodash and rxjs collision a bare `map`
   would invite.

3. **Verifier variants are a namespace: `verifier.llmJudge` /
   `verifier.expression` / `verifier.jsonPath`.** The three are a discriminated
   union inside one config, not three node types. Every variant writes the same
   two keys, so downstream edges branch on `_passed` identically; the inner
   `type` only selects how the check runs. Three call sites, each taking only
   its own fields, replaces a nested discriminator the author has to get right.

4. **Helpers omit `writes` where the engine implies it.** `impliedResultKeys`
   derives result keys for verifier, reflection, mapReduce, voting, evolution,
   tool, a2a, and subgraph. Accepting `writes` for those invites a declaration
   that disagrees with what the executor actually writes. The helpers drop it,
   leaving the implied grant the only path.

   `writes` stays on the types whose agent authors the output: `agent`,
   `supervisor`, `router`, and `approval`.

   **`synthesizer` belongs in the second group whenever it has an agent.** Its
   executor branches: agentless, it writes the implied `${id}_synthesis`; with
   an agent, it calls `executeAgent` with `grantedWriteKeys: node.write_keys`
   and authors output like any agent node. Dropping `writes` there silently
   leaves the agent able to write nothing, which a live run of the map-reduce
   example surfaced as an empty summary.

5. **Config fields take the shorter names.** `manages`, `items`, `into`,
   `target`, `sources`. `subgraph()` set this precedent with `inputs` and
   `outputs`. The wire format is unchanged; the helper maps to it.

## Scope

The wire format does not change. These helpers compile to the same snake_case
`GraphNode` objects `node()` produces today, so persisted graphs, the architect,
and `mc-ai-api` are unaffected.

Tests should cover, for each helper: the emitted wire node matches the
hand-authored equivalent byte for byte, and misuse fails to compile.
