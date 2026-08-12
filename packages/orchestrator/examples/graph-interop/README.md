# Graph Interop

Distributing a graph to someone who did not write it, and composing with a
graph you did not write.

A `bundle()` is the artifact that crosses that boundary: one JSON document
carrying the graph, its agent definitions, its transitive child-graph
closure, and a manifest that states the contract in both directions.

```
   publish.ts                                     consume.ts
   ──────────                                     ──────────
   graph({ inputs, outputs })                     parseBundle(json)
        │                                              │
        ▼                                              ▼
   bundle(g, { version })  ──▶ .bundle.json ──▶   read manifest
        │                          (npm,               │
        │                        registry,             ▼
        │                       object store)     checkRequirements()
        │                                              │
   implementations                                     ▼
   stay behind ───────────────────────────────▶   bind tools by name
                                                       │
                                                       ▼
                                                  subgraph(block, …)
```

The two files do not import each other. `consume.ts` reads a JSON file and
nothing else, which is the whole point.

## What travels, and what does not

| In the artifact | Not in the artifact |
|---|---|
| The graph topology and every embedded child graph | Custom tool implementations |
| Agent definitions: model, prompt, tool references | Provider API keys |
| `manifest.inputs` / `manifest.outputs` — the interface as JSON Schema | MCP server transport configs |
| `manifest.requires` — models, MCP server ids, and custom tool names with their argument schemas | Anything host-specific |

Implementations never travel. The publisher's `fetch_market_data` is real
code used to author and test the block, but only its **name** and
**argument schema** ship. The consuming host binds its own data source to
that name. That separation is what makes a graph portable: the block
describes the capability it needs, the host decides what satisfies it.

## The consumer's sequence

**1. `parseBundle()`, never bare `JSON.parse()`.**

It validates the artifact's shape *and* cross-checks the manifest against
what the bundle actually does. A manifest that under-declares its
dependencies is either tampered with or mis-assembled, and either way it is
rejected before anything runs:

```
BundleIntegrityError: Bundle usage exceeds its manifest requires:
  - agent "…" uses custom tool "fetch_market_data" not declared in requires.tools
```

This keeps the reviewed declaration honest. Whatever a human or a policy
gate approved in the manifest is what the artifact is allowed to do.

**2. Read the manifest.**

Interface and requirements are both plain data, so the entire contract is
inspectable without executing a node. This is what a registry listing, a
review UI, or a policy check reads.

**3. `checkRequirements()` to preflight.**

Fail fast with a missing list rather than deep in a run:

```typescript
await checkRequirements(block, {});                    // ok: false, missingTools: ['fetch_market_data']
await checkRequirements(block, { tools: [marketData] }); // ok: true
```

It accepts a `GraphBundle` (checks the manifest's declared `requires`) or a
`Graph` (computes requirements from the composition closure). The manifest
is what makes a deserialized bundle checkable at all — its authoring stashes
did not survive serialization.

**4. Compose.**

`subgraph()` takes the bundle directly. The declared interface survived
serialization, so a mis-wire against a block you downloaded fails at compile
time exactly as a local child graph would:

```
GraphSpecError: Subgraph node "analyze-sector" maps parent key "target_sector"
to child input "industry", but graph "market-analysis-block" declares no such
input. Declared inputs: sector, year
```

The bundle's agents auto-register from the artifact. Only the tool
implementation has to be handed to the runner, because it is the one thing
the manifest names but does not carry.

## Defense in depth on capabilities

`requires` is not only documentation. A bundle's manifest becomes a runtime
**capability ceiling**: the child cannot use tools, MCP servers, or models
beyond what it declared, even by way of a host-supplied agent referenced by
id. `verifyBundleIntegrity` at load time covers what the artifact makes
visible; the ceiling covers the rest.

Note the `taints: true` on `fetch_market_data`. External data stays flagged
in `state.taint_registry` across the composition boundary in both
directions, so a consumer's taint-gated nodes stay gated on data that
entered through a third-party block.

## Running it

```bash
cd packages/orchestrator

# 1. Publish — writes market-analysis.bundle.json. No API key needed.
npx tsx examples/graph-interop/publish.ts

# 2. Consume — reads the artifact and runs it.
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/graph-interop/consume.ts
```

`market-analysis.bundle.json` is generated by `publish.ts` and checked in so
`consume.ts` runs standalone and the artifact can be read directly. Re-run
`publish.ts` to regenerate it; graph and agent ids are freshly minted each
time, so the file changes on every publish.

## Files

| File | Role |
|---|---|
| `publish.ts` | Authors the block, declares its interface, assembles and writes the bundle |
| `consume.ts` | Reads the artifact, validates it, preflights requirements, binds a tool, composes and runs |
| `market-analysis.bundle.json` | The distribution artifact |

## Related

- [graph-interface](../graph-interface/) — declaring `inputs`/`outputs` and
  wiring onto that signature, without the distribution layer
- [composition](../composition/) — `subgraph()` with in-scope child graphs
