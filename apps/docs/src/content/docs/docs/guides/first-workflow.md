---
title: Your First Workflow
description: Build a complete workflow step-by-step using the research-and-write pattern.
---

This guide walks you through building a **linear 2-node workflow**: a Researcher agent gathers notes, then a Writer agent produces a polished summary. You author it with the same `agent` / `node` / `graph` facade the [Quickstart](/docs/getting-started/quickstart/) uses, but instead of the one-call `run()` helper you drive an explicit `GraphRunner`. Reach for this level when you need custom persistence, event listeners, streaming, or other runner wiring that `run()` does not expose. The facade compiles to exactly the graph the runner executes, so nothing is lost by dropping down.

## Step 1: Define agents

An `agent()` value is a capability: model, instructions, sampling. It carries no id (the registry mints one when the graph compiles) and no state grants (the node it runs on is the authoritative grant). The provider is inferred from the model name, so `claude-*` resolves to Anthropic without a `provider` field.

```typescript
import { agent } from '@cycgraph/orchestrator';

const researcher = agent({
  name: 'Research Agent',
  model: 'claude-sonnet-4-6',
  instructions: 'You are a research specialist. Investigate the topic and produce thorough research notes.',
  temperature: 0.5,
  maxSteps: 3,
});

const writer = agent({
  name: 'Writer Agent',
  model: 'claude-sonnet-4-6',
  instructions: 'You are a writer. Read the research notes from memory and produce a clear, engaging summary.',
  temperature: 0.7,
  maxSteps: 3,
});
```

## Step 2: Place them in a graph

A `node()` value is a placement: a topology id that edges reference, the state keys it may read and write, and the agent that runs there. `graph()` resolves the agent references, expands the edge sugar, and emits the validated `Graph`. `failurePolicy` keeps only the fields that differ from the defaults, so `{ maxRetries: 2 }` overrides just the retry count.

```typescript
import { node, graph } from '@cycgraph/orchestrator';

const research = node({
  id: 'research',
  agent: researcher,
  reads: ['goal', 'constraints'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 2 },
});

const write = node({
  id: 'write',
  agent: writer,
  reads: ['goal', 'research_notes'],
  writes: 'draft',
  failurePolicy: { maxRetries: 2 },
});

const workflow = graph({
  name: 'Research & Write',
  description: 'Two-node linear workflow: research then write',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});
```

`startNode` and `endNodes` are inferred for a simple chain. A cyclic graph would require them explicitly.

## Step 3: Seed the state

Use `state()` to build the initial `WorkflowState`. It generates the `run_id`, timestamps, and required structural defaults; you supply the goal and any seed memory.

```typescript
import { state } from '@cycgraph/orchestrator';

const initialState = state({
  workflowId: workflow.id,
  goal: 'Explain how large language models work, including transformers, attention mechanisms, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 120_000,
});
```

## Step 4: Run with an explicit runner

The facade stashed each agent's config on the compiled graph. Pull them out with `agentsForGraph()` and register them into a run-scoped registry, then pass that registry to the runner. Scoping the registry into the run keeps agents out of process-global state, so concurrent runs never contaminate each other.

```typescript
import {
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryPersistenceProvider,
} from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const persistence = new InMemoryPersistenceProvider();
const runner = new GraphRunner(workflow, initialState, {
  registry,   // scope agents to this run
  persistState: async (snapshot) => {
    await persistence.saveWorkflowSnapshot(snapshot);
  },
});

// Listen for events for observability
runner.on('node:complete', ({ node_id, duration_ms }) => {
  console.log(`✅ ${node_id} finished in ${duration_ms}ms`);
});

const finalState = await runner.run();

if (finalState.status === 'completed') {
    console.log('\n═══ Final Draft ═══');
    console.log(finalState.memory.draft);
} else {
    console.error(`Workflow ended with status: ${finalState.status}`);
}
```

## Using streaming instead

For real-time output instead of waiting for the full run to complete, use `stream()`:

```typescript
for await (const event of runner.stream()) {
  switch (event.type) {
    case 'agent:token_delta':
      process.stdout.write(event.token);
      break;
    case 'node:complete':
      console.log(`\n✅ ${event.node_id} done in ${event.duration_ms}ms`);
      break;
    case 'workflow:complete':
      console.log('\nDraft:', event.state.memory.draft);
      break;
  }
}
```

## Next steps

- [Supervisor](/docs/patterns/supervisor/): add dynamic LLM-powered routing
- [Custom LLM Providers](/docs/guides/custom-providers/): use Groq, Ollama, or other providers
- [Tools & MCP](/docs/concepts/tools-and-mcp/): give agents external capabilities
