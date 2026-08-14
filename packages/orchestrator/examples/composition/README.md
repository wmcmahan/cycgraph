# Composition

Whole graphs as reusable blocks. A research pipeline is built once as its own
graph, then embedded in a briefing workflow with `subgraph()`. The child runs
in isolated state, memory crosses only through the declared mappings, and
`run()` resolves the child and registers its agents with no hand-wired
`loadGraph`.

## Graph

```
briefing
  ├── research  (subgraph node)
  │     ├── gather     → notes
  │     └── summarize  → summary
  └── brief → executive_brief

  inputs:  { research_topic → topic }  parent key → child key
  outputs: { summary → findings }      child key → parent key
```

The child's own nodes never appear in the parent topology. From the parent's
side it is one node with a declared interface.

## Lifecycle & State

| Scope | Key | Notes |
| --- | --- | --- |
| parent | `research_topic` | seeded, mapped in as the child's `topic` |
| child | `topic`, `notes`, `summary` | isolated; the parent never sees these |
| parent | `findings` | mapped back out of the child's `summary` |
| parent | `executive_brief` | written by `brief` from `findings` |

Only mapped keys cross in either direction. The child cannot read parent memory
it was not given, and the parent cannot see child working state.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/composition/composition.ts

# or free, against a local model:
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/composition/composition.ts
```

## Expected Output

```
═══ Findings ═══
- Solid-state batteries replace liquid electrolyte with a solid conductor…

═══ Executive Brief ═══
Solid-state batteries are approaching commercial viability…
```

## Notes

The same block can be embedded in any number of parents, each supplying
different mappings. Nothing in the research graph knows it is being composed.

To ship a block to another project, see [graph-interop](../graph-interop/),
which lifts one into a portable bundle.
