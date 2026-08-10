---
title: Quickstart
description: Build and run a workflow in a handful of lines with the authoring facade.
---

The fastest way to a running workflow is the authoring vocabulary. A quick rundown on the building blocks:

- [agent](/docs/concepts/agents/) - a capability: model, instructions, tools. No id (the registry mints one), no placement.
<br/>
- [node](/docs/concepts/nodes/) - a placement: where work happens in the topology, with its id and state grants.
<br/>
- [graph](/docs/concepts/graphs/) - the compiler: resolves references and emits the serializable wire graph.
<br/>
- [state](/docs/concepts/workflow-state/) - a workflow state, when you want to seed it explicitly instead of passing raw input to 
`run`.
<br/>
- [run](/docs/concepts/graph-runner) - the executor: registers the agents into a run-scoped registry and drives the runner.
<br/>
- [tool](/docs/concepts/tools-and-mcp) - a custom tool definition (alias of `defineTool`), referenced by value from any agent or node; `run` registers it automatically.

The graph topology stays fully explicit; the facade only removes ceremony, and it compiles to the exact same graph the raw API produces.

## A multi-agent workflow

```typescript
import { agent, node, graph, run } from '@cycgraph/orchestrator';

const research = node({
  id: 'research',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'You are a research specialist. Produce concise, factual notes.',
  }),
  reads: ['goal'],
  writes: 'notes',
});

const write = node({
  id: 'write',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'Turn the research notes into a clear summary under 300 words.',
  }),
  reads: ['goal', 'notes'],
  writes: 'draft'
});

const workflow = graph({
  name: 'research-write',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

const { draft } = await run(workflow, { goal: 'Explain how LLMs work' });
```

## Flow stays explicit

The facade never hides the graph. Conditional edges and loops are spelled out with `when`:

```typescript
const workflow = graph({
  name: 'review-loop',
  nodes: [draft, review],
  edges: [
    { from: draft, to: review },
    { from: review, to: draft, when: 'memory.score < 0.7' }, // loop back until good enough
  ],
  startNode: draft,
  endNodes: [review],
});
```

`startNode`/`endNodes` are inferred for a simple chain and required when the graph is cyclic or otherwise ambiguous — a clear error, never a guess.

## Agents that aren't nodes

Some patterns reference agents from *config* rather than placing them as nodes — a supervisor's routing brain, an evolution candidate, an evaluator. Pass the agent value wherever the config wants an agent id:

```typescript
const brain = agent({ model: 'claude-sonnet-4-6', instructions: 'Route work to the right specialist…' });

const supervisor = node({
  id: 'supervisor',
  type: 'supervisor',
  agent: brain,
  supervisorConfig: { managedNodes: [research, write], maxIterations: 10 },
});
```

No grants needed: a supervisor's permissions derive from its role. Routing (`handoff`) and completion (`set_status`) are implied by the node type, and its reads derive from its team — a supervisor with no declared `reads` sees `goal`, `constraints`, and everything its `managedNodes` write, nothing else. Declare `reads` explicitly only to widen or narrow that.

`graph()` resolves every agent reference — on nodes or deep inside config blocks like `evolutionConfig.candidateAgentId` — and `run()` registers them all.

## Non-agent nodes

Every node type is authored the same way — `node()` with its `type`:

```typescript
const lookup = node({ id: 'lookup', type: 'tool', toolId: 'web_fetch', tools: ['web_fetch'], reads: ['goal'] });
```

## Composing graphs

Whole graphs compose too. `subgraph()` embeds a child graph as a single node, with isolated state and explicit memory mappings. `run()` resolves an in-scope child and registers its agents automatically:

```typescript
const research = graph({ name: 'research-block', nodes: [/* … */] });

const pipeline = graph({
  name: 'briefing',
  nodes: [
    subgraph(research, {
      id: 'research',
      inputs:  { topic: 'goal_in' },     // parent key → child key
      outputs: { summary: 'findings' },  // child key → parent key
      writes: 'findings',
    }),
    write,
  ],
  edges: [{ from: 'research', to: write }],
});
```

The child sees only the mapped keys, never the parent's blackboard, which is what makes a graph a dependable building block. See the [Subgraph pattern](/docs/patterns/subgraph/).

## When to reach past the facade

The facade covers the common case. For custom persistence, event listeners, budget/rate limiting, distributed workers, or pre-registered agents in a database, drop to the raw `createGraph` + `GraphRunner` API — the facade compiles to exactly that, so there's no cliff. See [Graphs](/docs/concepts/graphs/), [Graph Runner](/docs/concepts/graph-runner/), and the runnable examples in `packages/orchestrator/examples/`.

## Serialization

`graph()` returns a plain, serializable graph — `JSON.stringify(workflow)` is the canonical wire that Postgres stores and the runner executes. Agent ids are minted UUIDs by default; pin them (`agent({ id: 'research-brain', … })`) when you want deterministic graph JSON, e.g. for shareable graphs.

## Next steps

- [Graphs](/docs/concepts/graphs/): the full graph model and node types
- [Agents](/docs/concepts/agents/): agent configuration in depth
- [Tools & MCP](/docs/concepts/tools-and-mcp/): giving agents tools
