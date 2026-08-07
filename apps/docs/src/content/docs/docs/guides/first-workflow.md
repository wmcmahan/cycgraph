---
title: Your First Workflow
description: Build a complete workflow step-by-step using the research-and-write pattern.
---

This guide walks you through building a **linear 2-node workflow** with the raw graph API: a Researcher agent gathers notes, then a Writer agent produces a polished summary. It's the explicit version of the same workflow the [Quickstart](/docs/getting-started/quickstart/) builds with the terse `agent` / `graph` / `run` facade — reach for this level when you need custom persistence, event listeners, or advanced wiring.

## Step 1: Register agents

We start by defining our agents and registering them with an `AgentRegistry`.

```typescript
import { InMemoryAgentRegistry, createProviderRegistry } from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You are a research specialist. Investigate the topic and produce thorough research notes.',
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: { readKeys: ['goal', 'constraints'], writeKeys: ['research_notes'] },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You are a writer. Read the research notes from memory and produce a clear, engaging summary.',
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: { readKeys: ['goal', 'research_notes'], writeKeys: ['draft'] },
});

const providers = createProviderRegistry(); // built-in Anthropic + OpenAI
```

The registry and providers are scoped into the run in Step 3 (via `GraphRunnerOptions`), so nothing here mutates process-global state.

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
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
    },
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'research_notes'],
      writeKeys: ['draft'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
    },
  ],

  edges: [
    {
      source: 'research',
      target: 'write',
      condition: { type: 'always' },
    },
  ],

  startNode: 'research',
  endNodes: ['write'],
});
```

## Step 3: Create initial state

Use the `createWorkflowState` helper to automatically generate the `run_id`, timestamps, and required structural defaults.

```typescript
import { createWorkflowState } from '@cycgraph/orchestrator';

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Explain how large language models work, including transformers, attention mechanisms, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 120_000,
});
```

## Step 4: Run

```typescript
import { GraphRunner, InMemoryPersistenceProvider } from '@cycgraph/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const runner = new GraphRunner(graph, initialState, {
  registry,   // scope agents to this run
  providers,  // scope providers to this run
  persistState: async (state) => {
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

- [Supervisor](/docs/patterns/supervisor/): add dynamic LLM-powered routing
- [Custom LLM Providers](/docs/guides/custom-providers/): use Groq, Ollama, or other providers
- [Tools & MCP](/docs/concepts/tools-and-mcp/): give agents external capabilities
