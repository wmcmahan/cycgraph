---
title: Your First Workflow
description: Build a complete workflow step-by-step using the research-and-write pattern.
---

This guide walks you through building a **linear 2-node workflow**: a Researcher agent gathers notes, then a Writer agent produces a polished summary. We'll build this programmatically, exactly as it's done in the [research-and-write example](https://github.com/wmcmahan/cycgraph/tree/main/packages/orchestrator/examples/research-and-write).

## Step 1: Register agents

We start by defining our agents and registering them with the `AgentRegistry`.

```typescript
import {
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
} from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist. Investigate the topic and produce thorough research notes.',
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: { read_keys: ['goal', 'constraints'], write_keys: ['research_notes'] },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a writer. Read the research notes from memory and produce a clear, engaging summary.',
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: { read_keys: ['goal', 'research_notes'], write_keys: ['draft'] },
});

// Wire the registry into the global factory
configureAgentFactory(registry);

// Configure LLM providers
const providers = createProviderRegistry();
configureProviderRegistry(providers);
```

## Step 2: Define the graph

Use the `createGraph` helper to build a validated `Graph` definition. We construct two nodes, plugging in the agent IDs we just generated. 

```typescript
import { createGraph } from '@cycgraph/orchestrator';

const graph = createGraph({
  name: 'Research & Write',
  description: 'Two-node linear workflow: research then write',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal', 'constraints'],
      write_keys: ['research_notes'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
    },
    {
      id: 'write',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['goal', 'research_notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
    },
  ],

  edges: [
    {
      source: 'research',
      target: 'write',
      condition: { type: 'always' },
    },
  ],

  start_node: 'research',
  end_nodes: ['write'],
});
```

## Step 3: Create initial state

Use the `createWorkflowState` helper to automatically generate the `run_id`, timestamps, and required structural defaults.

```typescript
import { createWorkflowState } from '@cycgraph/orchestrator';

const initialState = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Explain how large language models work, including transformers, attention mechanisms, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
  max_execution_time_ms: 120_000,
});
```

## Step 4: Run

```typescript
import { GraphRunner, InMemoryPersistenceProvider } from '@cycgraph/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowSnapshot(state);
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

- [Supervisor](/docs/patterns/supervisor/) — add dynamic LLM-powered routing
- [Custom LLM Providers](/docs/guides/custom-providers/) — use Groq, Ollama, or other providers
- [Tools & MCP](/docs/concepts/tools-and-mcp/) — give agents external capabilities
