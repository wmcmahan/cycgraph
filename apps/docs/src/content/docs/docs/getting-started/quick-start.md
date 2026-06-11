---
title: Quick Start
description: Install cycgraph and run your first workflow in under 5 minutes.
---

Install cycgraph, set up an LLM provider, and run a complete workflow with persistence.

## 1. Installation

cycgraph requires **Node.js 24+** (ES Modules).

Install the core orchestrator package, and optionally the Postgres persistence package if you want durable database storage:

```bash
npm install @cycgraph/orchestrator

# Optional PostgreSQL persistence adapter
npm install @cycgraph/orchestrator-postgres
```

## 2. API keys

Set your provider key. This quick start uses Anthropic:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## 3. Minimal workflow example

A complete, standalone example: configure a provider, register an agent that writes a draft, define the graph, and run it with in-memory persistence.

Create a file named `workflow.ts`:

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
  // 1. Configure LLM providers
  const providers = createProviderRegistry();
  configureProviderRegistry(providers);

  // 2. Register an agent (registry auto-generates and returns the UUID)
  const registry = new InMemoryAgentRegistry();

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

  // 3. Define the graph (createGraph fills in defaults like id)
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

  // 4. Initialize state (createWorkflowState fills in run_id, timestamps, defaults)
  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Explain how transformers work in AI.',
    max_execution_time_ms: 60_000,
  });

  // 5. Set up persistence and run
  const persistence = new InMemoryPersistenceProvider();
  const runner = new GraphRunner(graph, state, {
    persistStateFn: async (s) => {
      await persistence.saveWorkflowSnapshot(s);
      console.log(`[State Persisted] Status: ${s.status}, Node: ${s.visited_nodes.slice(-1)[0]}`);
    },
  });

  console.log('Starting workflow...');
  const result = await runner.run();

  console.log('\n--- Final Output ---');
  console.log(result.memory.draft);
}

main().catch(console.error);
```

## Adding durable persistence (PostgreSQL)

`InMemoryPersistenceProvider` is fine for scripts. For production, swap it for the Postgres adapter so workflows survive process restarts.

```typescript
import {
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  getDb,
} from '@cycgraph/orchestrator-postgres';

// Ensure the connection pool is initialized (reads DATABASE_URL by default)
await getDb();

const persistence = new DrizzlePersistenceProvider();
const eventLog = new DrizzleEventLogWriter();

// Hook them into the runner
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
  eventLog, // enables durable event-sourced replay
});
```

## Next steps

- [Core Concepts](/docs/concepts/overview/) — how graphs, nodes, and reducers fit together.
- [Workflow Patterns](/docs/patterns/supervisor/) — examples of multi-agent patterns you can build.
