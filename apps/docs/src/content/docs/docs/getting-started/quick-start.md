---
title: Quick Start
description: Install CYCGRAPH and run your first workflow in under 5 minutes.
---

The core package is for your workflows.

```bash
npm install @cycgraph/orchestrator
```

Optional Postgres persistence package for durable postgres storage

```bash
npm install @cycgraph/orchestrator-postgres
```

## API keys

Provider keys are set via environment variables. Both Anthropic and OpenAI are supported.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-openai-..."
```

## Example

```typescript
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

async function main() {
  // Create and configure the provider registry
  const providers = createProviderRegistry();
  configureProviderRegistry(providers);

  // Create and agent registry
  const registry = new InMemoryAgentRegistry();

  // Register an agent
  const writerId = registry.register({
    name: 'Research Writer',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system_prompt: 'You are an expert technical writer. Produce a concise summary of the goal.',
    temperature: 0.7,
    max_steps: 3,
    tools: [],
    permissions: { read_keys: ['goal'], write_keys: ['draft'] },
  });

  configureAgentFactory(registry);

  // Define the graph
  const graph = createGraph({
    name: 'Simple Writer Workflow',
    description: 'Single agent that writes a draft from the goal.',
    nodes: [
      {
        id: 'write_node',
        type: 'agent',
        agent_id: writerId,
        read_keys: ['goal'],
        write_keys: ['draft'],
      },
    ],
    edges: [],
    start_node: 'write_node',
    end_nodes: ['write_node'],
  });

  // Initialize state
  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Explain how transformers work in AI.',
    max_execution_time_ms: 60_000,
  });

  // Set up in-memory persistence
  const persistence = new InMemoryPersistenceProvider();

  // Create the runner
  const runner = new GraphRunner(graph, state, {
    persistStateFn: async (s) => {
      await persistence.saveWorkflowSnapshot(s);
      console.log(`[State Persisted] Status: ${s.status}, Node: ${s.visited_nodes.slice(-1)[0]}`);
    },
  });

  // Run the workflow
  const result = await runner.run();

  console.log('\n--- Final Output ---');
  console.log(result.memory.draft);
}

main().catch(console.error);
```

## Adding durable persistence (PostgreSQL)

In-memory persistence is fine for some workflows, but long running workflows or workflows that need to be resumed later should use Postgres persistence.

```typescript
import {
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  getDb,
} from '@cycgraph/orchestrator-postgres';

// Ensure the connection pool is initialized
await getDb();

const persistence = new DrizzlePersistenceProvider();
const eventLog = new DrizzleEventLogWriter();

// Hook them into the runner
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
  eventLog,
});
```

## Next steps

- [Core Concepts](/docs/concepts/overview/) — how graphs, nodes, and reducers fit together.
- [Workflow Patterns](/docs/patterns/supervisor/) — examples of multi-agent patterns you can build.
