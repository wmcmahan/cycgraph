---
title: Using the Architect
description: Generate workflow graphs from natural language prompts.
---

The **Workflow Architect** generates valid, executable [Graph](/docs/concepts/graphs/) definitions from natural language descriptions using an LLM. Instead of hand-writing nodes and edges, you describe what you want and the Architect produces the graph structure.

Generated graphs are **never executed automatically**. They're returned for review before you run or publish them.

## Generating a workflow

The `generateWorkflow()` function takes a prompt and returns a validated `Graph`:

```typescript
import { generateWorkflow } from '@cycgraph/orchestrator';

const { graph, warnings } = await generateWorkflow({
  prompt: 'Monitor Hacker News for AI news, summarize daily, post to Slack',
});

```

### What happens under the hood

1. Your prompt is sent to an LLM with a system prompt that understands the graph schema
2. A generated graph JSON is returned via `Output.object`
3. The output is validated with `validateGraph()` (checks referential integrity, reachability, etc.)
4. If validation fails, the errors are fed back to the LLM for self-correction (up to 2 retries by default)
5. The valid graph is returned for your review

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prompt` | `string` | *required* | Natural language description of the desired workflow. |
| `currentGraph` | `Graph` | — | Existing graph to modify (enables iterative refinement). |
| `architectAgentId` | `string` | `'architect-agent'` | Agent ID whose model config to use for generation. |
| `maxRetries` | `number` | `2` | Max self-correction attempts on validation failure. |

### Return value

| Field | Type | Description |
|-------|------|-------------|
| `graph` | `Graph` | The generated, validated graph, ready to run or publish. |
| `raw` | `LLMGraph` | Raw LLM output before conversion (useful for debugging). |
| `attempts` | `number` | Number of generation attempts (1 = first try, 2+ = self-corrected). |
| `warnings` | `string[]` | Non-fatal warnings from graph validation. |
| `is_modification` | `boolean` | Whether this was a modification of an existing graph. |

## Iterative refinement

Pass an existing graph alongside a follow-up prompt to modify it. The Architect preserves unmodified nodes and edges while applying your structural changes:

```typescript
const { graph: updatedGraph } = await generateWorkflow({
  prompt: 'Add a Slack notification step after the summarizer',
  currentGraph: existingGraph,
});
```

This is useful for incrementally building up complex workflows through conversation, or for adjusting a generated graph without starting from scratch.

## Running a generated graph

Once you have a graph, use it like any other. Create state and run:

```typescript
import { GraphRunner, createWorkflowState } from '@cycgraph/orchestrator';

const state = createWorkflowState({
  workflowId: graph.id,
  goal: 'Summarize today\'s top AI news from Hacker News',
});

const runner = new GraphRunner(graph, state);

const result = await runner.run();
```

## Giving agents Architect tools

Instead of calling `generateWorkflow()` directly, you can give the Architect's built-in tools to an agent. This lets the agent design, modify, and publish workflows autonomously as part of a larger workflow or chat interaction.

### Step 1: Initialize persistence

The publish and get tools need to save/load graphs from your storage backend. Call `initArchitectTools()` once at application startup with `saveGraph` and `loadGraph` callbacks. Any persistence implementation works: in-memory for development, Drizzle/Postgres for production.

```typescript
import { InMemoryPersistenceProvider, initArchitectTools } from '@cycgraph/orchestrator';

const persistence = new InMemoryPersistenceProvider();

initArchitectTools({
  saveGraph: async (graph) => persistence.saveGraph(graph),
  loadGraph: async (id) => persistence.loadGraph(id),
});
```

For production, swap in `DrizzlePersistenceProvider` from `@cycgraph/orchestrator-postgres`. The callback signatures are identical.

`architect_publish_workflow` always validates the graph (`GraphSchema.parse` + `validateGraph`) before it reaches `saveGraph`, so an agent cannot publish a malformed or unsafe graph. For agent-driven publishing you should also gate it: provide a `canPublish` callback that returns `true` to allow, or a string reason to deny (e.g. require human approval or check a privileged credential).

```typescript
initArchitectTools({
  saveGraph: async (graph) => persistence.saveGraph(graph),
  loadGraph: async (id) => persistence.loadGraph(id),
  canPublish: async (graph) =>
    (await isApprovedByHuman(graph.id)) || 'human approval required',
});
```

:::note
The draft tool works without initialization, because it only generates graphs in memory. The publish and get tools will throw `ArchitectError` if called before `initArchitectTools()`. A graph that fails schema or referential validation is returned as an error result (not persisted), and a `canPublish` denial returns an error result too.
:::

### Step 2: Define an agent with Architect tools

The Architect tools are built-ins, so a bare name in the `tools` array is enough. Grant the node that places this agent broad state access (`reads: ['*']`, `writes: ['*']`) so it can see the workflow context it is designing for.

```typescript
import { agent } from '@cycgraph/orchestrator';

const designer = agent({
  name: 'Workflow Designer',
  model: 'claude-sonnet-4-6',
  instructions:
    'You design and manage automation workflows. ' +
    'Use architect_draft_workflow to create or modify graphs, ' +
    'architect_publish_workflow to save them, ' +
    'and architect_get_workflow to inspect existing ones.',
  tools: [
    'architect_draft_workflow',
    'architect_publish_workflow',
    'architect_get_workflow',
  ],
});
```

### Step 3: The agent manages the full lifecycle

The agent can now handle the **Draft → Review → Publish** loop autonomously:

```
You:   "We need a workflow that scrapes competitors' pricing pages and sends a Slack summary"
Agent: [calls architect_draft_workflow] → generates graph
Agent: "Here's what I designed: 3 nodes (scraper → analyzer → notifier)..."
You:   "Add error retries to the scraper node"
Agent: [calls architect_draft_workflow with currentGraph] → refined graph
Agent: "Updated. Want me to publish it?"
You:   "Yes"
Agent: [calls architect_publish_workflow] → saved to registry
```

## Architect tools reference

| Tool | Needs `initArchitectTools()`? | Description |
|------|-------------------------------|-------------|
| `architect_draft_workflow` | No | Generate a graph from a prompt, or modify an existing graph. Returns the graph for review. |
| `architect_publish_workflow` | Yes | Save a graph to the persistent registry. Set `overwrite: true` to update an existing graph. |
| `architect_get_workflow` | Yes | Load a published graph by ID. |

## Next steps

- [Graphs](/docs/concepts/graphs/): the graph format the Architect generates
- [Nodes](/docs/concepts/nodes/): the full node type reference
- [Supervisor](/docs/patterns/supervisor/): combine the Architect with supervisor routing
