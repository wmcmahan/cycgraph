# Graph Interface

A graph's `inputs` and `outputs` are its **type signature**. Declaring them
turns a composition boundary from two untyped string dictionaries into a
contract that is checked when the parent compiles and again when the child
runs.

```
        parent memory                    child memory
   ┌──────────────────────┐         ┌────────────────────┐
   │ research_topic ──────┼── in ──▶│ topic   (required) │
   │ research_depth ──────┼── in ──▶│ depth?  (enum)     │
   │                      │         │                    │
   │ findings      ◀──────┼── out ──┤ summary            │
   └──────────────────────┘         └────────────────────┘
                            ▲
                    the mapping is the call;
                the declared interface is the signature
```

## Why this matters

Without a declared interface, `inputs: { research_topic: 'subject' }` is a
valid mapping to a child that has no `subject` key. Nothing errors. The key
is simply never seeded, the child runs against empty memory, and the damage
surfaces three nodes downstream as a bad answer that looks like a model
problem. Interfaces convert that class of bug into an error that names the
key and lists what was actually declared.

The check runs in two places, and both matter:

1. **Compile time**, in `graph()`. A `subgraph()` mapping is validated
   against the child's declaration: an undeclared child key does not
   compile, a required input left unmapped does not compile, and an
   undeclared output does not compile.
2. **Run time**, in the subgraph executor. Before the child starts, every
   seeded value is parsed against its declared schema, and every mapped
   result is parsed on the way back out. This path does not depend on the
   authoring facade, which is what makes it load-bearing: a child resolved
   by id at run time (a graph from a registry, a downloaded bundle) never
   saw the compile-time check.

A child that declares **no** interface validates nothing. Degradation is
graceful, so interfaces are adoptable one graph at a time.

## Declaring an interface

Zod going in, JSON Schema on the wire. The projection uses `z.toJSONSchema`,
so a consumer that only ever sees the serialized graph still knows how to
call it.

```typescript
const researchBlock = graph({
  name: 'research-block',
  nodes: [gather, summarize],
  edges: [{ from: gather, to: summarize }],

  inputs: {
    topic: { schema: z.string().min(3), description: 'The subject to research' },
    depth: { schema: z.enum(['brief', 'deep']).default('brief'), description: 'How much detail' },
  },
  outputs: {
    notes:   { schema: z.string(), description: 'Raw bullet-point findings' },
    summary: { schema: z.string(), description: 'The five most important points' },
  },
});
```

`required` is **derived**, not declared: a schema that accepts `undefined`
is optional. `z.string().min(3)` is required; `z.enum([...]).default('brief')`
is not. Override it with an explicit `required` when you want something else.

Raw JSON Schema passes through untouched, so a graph assembled by a tool
that does not speak Zod can still declare a signature:

```typescript
inputs: { payload: { type: 'object', properties: { n: { type: 'number' } } } }
```

## Declared outputs must match what nodes actually write

An agent node writes its text output to its `writes` key, as a string. So
`outputs: { summary: z.string() }` is honest and `outputs: { sources:
z.array(z.string()) }` is not — the output boundary check would reject a
run that otherwise succeeded. Declare structured output schemas only where
a tool, verifier, or extractor node produces the structure.

## What the example does

`research-block` declares an interface. `briefing` embeds it with
`subgraph()` and maps its own memory keys onto that signature, so the two
graphs are wired through the declaration rather than through shared key
names.

| File | Role |
|---|---|
| `index.ts` | Structural preflight, then runs `briefingGraph` twice |
| `reaserchGraph/` | The reusable block: its agents, nodes, declared `inputs`/`outputs`, and its reflection node |
| `briefingGraph/` | The parent: embeds the block via `subgraph()` and formats its output |
| `memory/` | The three runner hooks: retriever, writer, and context compressor |

Each graph directory keeps its agents and nodes in their own modules, so
the graph file itself is only topology and contract.

## Memory across the composition boundary

The graph runs twice, on two related topics, and the second run starts with
what the first one learned.

Both halves of that loop live **inside the child block**. Its `gather` node
carries a `memoryQuery` directive, and a `reflection` node at the end of the
block distils the notes into atomic facts. So the block carries its own
learning behaviour wherever it gets composed. The parent supplies the store,
not the wiring.

The three hooks are injected once, at the top-level `run()`:

```typescript
await run(briefingGraph, input, {
  runner: { memoryRetriever, memoryWriter, contextCompressor },
});
```

A subgraph child executes on its own `GraphRunner`, and the subgraph
executor forwards all three to it. That is what makes this work at all: the
nodes that retrieve and reflect are one level down, inside a graph the
parent treats as a black box. The same holds for a block installed from a
bundle — it gets your store and your compressor without knowing either
exists.

| Hook | What it does | Fires when |
|---|---|---|
| `memoryRetriever` | Fetches facts, rendered into a `## Relevant Memory` prompt section | A node declares `memoryQuery` |
| `memoryWriter` | Persists the facts a reflection node distils | A `reflection` node runs |
| `contextCompressor` | Compresses the sanitized memory slice before prompt injection | Every prompt build |

## Why the writer gates its writes

A reflection loop reads its own past lessons and re-derives them. Left
ungated over a long-lived store, the same handful of claims accumulates
under new ids and retrieval starts returning restatements instead of new
material. Exact string matching catches none of it.

The writer runs every candidate through `checkFactAdmission` from
`@cycgraph/memory`, which compares by similarity rather than equality and
also refuses re-entry of anything previously invalidated — a lesson an eval
gate deliberately evicted must not walk back in under a fresh id.

Run output reports the split:

```
  lessons available to this run: 7
  admitted by the gate:          7
  refused as already known:      0
  lessons after reflection:      14
```

**Expect zero refusals here, and note what that does and does not mean.**
The gate is wired and running. It has nothing to refuse, because its
default comparison is token overlap and this content defeats it.

Measured against real output from this example, restated claims score
0.11–0.27 while unrelated facts reach 0.31. The ranges overlap, so no
threshold separates them. The cause is that reflection does not reword a
lesson. It re-derives the claim with fresh specifics: "costs run 2–4×
conventional lithium-ion" comes back as "$160–300/kWh versus $80–100/kWh".
Same fact, almost no shared vocabulary — a semantic duplicate that lexical
comparison cannot see.

So treat the token-overlap default as a guard against near-verbatim
repeats, not as duplicate detection for a reflection loop. Pass
`embeddings` to `checkFactAdmission` for that, where the pairs above land
unmeasured here, and worth checking against your own corpus.

Two things are easy to get wrong here. A `memoryRetriever` wired on the
runner sits **dormant** until some node declares `memoryQuery` — the hook
alone does nothing. And a graph containing a `reflection` node throws
`MemoryWriterMissingError` at runtime if no `memoryWriter` is supplied, so
the two travel together.

One sharper edge: a reflection node whose `sourceKeys` name a key that is
not in memory writes **zero facts, silently**. No error, no warning. If run
2 shows no lessons, check that `sourceKeys` matches what the upstream node
actually wrote before suspecting the store.

## Three validation axes

The interface is one of three independent checks, and they differ in what
they inspect and how they report.

| Check | Mechanism | Reports as | When |
|---|---|---|---|
| Structure: referential integrity, reachability, edge syntax, node config | `validateGraph` | `ValidationResult` data | Explicit call; also automatic at run start |
| A mapping against the child's declared interface | `graph()` | throws `GraphSpecError` | Module evaluation |
| A boundary value against its declared schema | subgraph executor | throws `SubgraphInterfaceError` | During `run()` |

`validateGraph` knows nothing about declared interfaces. Its only subgraph
awareness is that a `subgraph_config` exists and names a `subgraph_id`. The
interface checks are a separate axis on top.

`index.ts` demonstrates the first and third. It calls `validateGraph` as a
preflight and prints the result, then wraps `run()` to handle a
`SubgraphInterfaceError`. It does not demonstrate the second, and that is
deliberate: a `GraphSpecError` is a build-time failure. `briefingGraph` is
built at module scope, so a mis-wire throws while `./briefingGraph` is being
imported, before any statement in `index.ts` runs. No try/catch there can
observe it, and staging one would mean shipping a deliberately broken graph
to print an error you would normally meet in your editor.

Expect two warnings from the preflight:

```
warning: Node 'research': read_keys entry 'research_topic' is not produced by any
         node in this graph — if it is not seeded via initial workflow memory, the
         node will see an empty value (possible typo)
```

Both are benign. Those keys are seeded through the `memory` argument to
`run()`, which the validator cannot see — it only knows which keys other
nodes in the same graph produce. That is why this is a warning and not an
error.

## Running it

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/graph-interface/index.ts
```

## Errors the boundary raises

| Error | Thrown by | When |
|---|---|---|
| `GraphSpecError` | `graph()` | A mapping references a key the child never declared, or omits a required input |
| `SubgraphInterfaceError` | subgraph executor | A seeded or returned value violates its declared schema. Carries `nodeId`, `subgraphId`, `direction`, and `key` |

## Related

- [composition](../composition/) — `subgraph()` without declared interfaces
- [graph-interop](../graph-interop/) — the same contract, serialized into a
  distributable bundle and consumed by a host that never saw the source
