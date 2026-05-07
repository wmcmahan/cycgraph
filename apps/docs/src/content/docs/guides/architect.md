---
title: Using the Architect
description: Generate workflow graphs from natural language prompts.
---

The **Workflow Architect** generates valid, executable [Graph](/concepts/graphs/) definitions from natural language descriptions using an LLM. Instead of hand-writing nodes and edges, you describe what you want and the Architect produces the graph structure.

Generated graphs are **never executed automatically** — they're returned for review before you run or publish them.

## Generating a workflow

The `generateWorkflow()` function takes a prompt and returns a validated `Graph`:

```typescript
import { generateWorkflow } from '@mcai/orchestrator';

const { graph, metadata } = await generateWorkflow({
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
| `current_graph` | `Graph` | — | Existing graph to modify (enables iterative refinement). |
| `architect_agent_id` | `string` | `'architect-agent'` | Agent ID whose model config to use for generation. |
| `max_retries` | `number` | `2` | Max self-correction attempts on validation failure. |

### Return value

| Field | Type | Description |
|-------|------|-------------|
| `graph` | `Graph` | The generated, validated graph — ready to run or publish. |
| `raw` | `LLMGraph` | Raw LLM output before conversion (useful for debugging). |
| `attempts` | `number` | Number of generation attempts (1 = first try, 2+ = self-corrected). |
| `warnings` | `string[]` | Non-fatal warnings from graph validation. |
| `is_modification` | `boolean` | Whether this was a modification of an existing graph. |

## Iterative refinement

Pass an existing graph alongside a follow-up prompt to modify it. The Architect preserves unmodified nodes and edges while applying your structural changes:

```typescript
const { graph: updatedGraph } = await generateWorkflow({
  prompt: 'Add a Slack notification step after the summarizer',
  current_graph: existingGraph,
});
```

This is useful for incrementally building up complex workflows through conversation, or for adjusting a generated graph without starting from scratch.

## Running a generated graph

Once you have a graph, use it like any other — create state and run:

```typescript
import { GraphRunner, createWorkflowState } from '@mcai/orchestrator';

const state = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Summarize today\'s top AI news from Hacker News',
});

const runner = new GraphRunner(graph, state);

const result = await runner.run();
```

## Giving agents Architect tools

Instead of calling `generateWorkflow()` directly, you can give the Architect's built-in tools to an agent. This lets the agent design, modify, and publish workflows autonomously as part of a larger workflow or chat interaction.

### Step 1: Initialize persistence

The publish and get tools need to save/load graphs from your storage backend. Call `initArchitectTools()` once at application startup with `saveGraph` and `loadGraph` callbacks. Any persistence implementation works — in-memory for development, Drizzle/Postgres for production:

```typescript
import { InMemoryPersistenceProvider, initArchitectTools } from '@mcai/orchestrator';

const persistence = new InMemoryPersistenceProvider();

initArchitectTools({
  saveGraph: async (graph) => persistence.saveGraph(graph),
  loadGraph: async (id) => persistence.loadGraph(id),
});
```

For production, swap in `DrizzlePersistenceProvider` from `@mcai/orchestrator-postgres` — the callback signatures are identical.

:::note
The draft tool works without initialization — it only generates graphs in memory. The publish and get tools will throw `ArchitectError` if called before `initArchitectTools()`.
:::

### Step 2: Register an agent with Architect tools

```typescript
import { InMemoryAgentRegistry } from '@mcai/orchestrator';

const registry = new InMemoryAgentRegistry();

const ARCHITECT_AGENT_ID = registry.register({
  name: 'Workflow Designer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt:
    'You design and manage automation workflows. ' +
    'Use architect_draft_workflow to create or modify graphs, ' +
    'architect_publish_workflow to save them, ' +
    'and architect_get_workflow to inspect existing ones.',
  tools: [
    { type: 'builtin', name: 'architect_draft_workflow' },
    { type: 'builtin', name: 'architect_publish_workflow' },
    { type: 'builtin', name: 'architect_get_workflow' },
  ],
  permissions: { read_keys: ['*'], write_keys: ['*'] },
});
```

### Step 3: The agent manages the full lifecycle

The agent can now handle the **Draft → Review → Publish** loop autonomously:

```
You:   "We need a workflow that scrapes competitors' pricing pages and sends a Slack summary"
Agent: [calls architect_draft_workflow] → generates graph
Agent: "Here's what I designed: 3 nodes (scraper → analyzer → notifier)..."
You:   "Add error retries to the scraper node"
Agent: [calls architect_draft_workflow with current_graph] → refined graph
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

- [Graphs](/concepts/graphs/) — the graph format the Architect generates
- [Nodes](/concepts/nodes/) — the full node type reference
- [Supervisor](/patterns/supervisor/) — combine the Architect with supervisor routing
