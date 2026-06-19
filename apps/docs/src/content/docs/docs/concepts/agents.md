---
title: Agents
description: How agents are defined, configured, and executed in cycgraph.
---

Agents are simply configurations that describe how to use an LLM to perform a task. There are no base classes to extend, no framework to inherit from. These rules feed into the agent runtime.

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto | Unique identifier |
| `name` | `string` | *required* | Human-readable name |
| `description` | `string` | — | Used by supervisor nodes to route work to this agent. |
| `model` | `string` | *required* | Model |
| `provider` | `string` | *required* | Provider |
| `system_prompt` | `string` | *required* | System prompt. |
| `temperature` | `number` | `0.7` | Value between 0.0 (deterministic) and 1.0 (creative). |
| `max_steps` | `number` | `10` | Safety limit for multi-step tool execution loops. |
| `tools` | `ToolSource[]` | `[]` | MCP tools |
| `model_preference` | `ModelTier` | — | Capability tier (`'high'`, `'medium'`, `'low'`) for [budget-aware model selection](/docs/guides/model-selection/). When set and a resolver is configured, overrides `model` at runtime. |
| `provider_options` | `object` | — | Provider-specific options |
| `permissions` | `object` | *required* | Zero-trust state permissions |

## Agent registry

The Agent Registry is a lookup interface to load these configurations into the runtime.

### Interface

When implementing a custom registry or interacting with an existing one, the following methods are available:

| Method | Parameters | Return Type | Description |
|--------|------------|-------------|-------------|
| `register` | `entry: AgentRegistryInput` | `string \| Promise<string>` | Register a new agent configuration and return its ID. |
| `loadAgent` | `id: string` | `Promise<AgentRegistryEntry \| null>` | Load an agent configuration by its ID. |
| `updateAgent` | `id: string, updates: Partial<AgentRegistryInput>` | `Promise<void>` | *(Optional)* Update an existing agent configuration. |
| `listAgents` | `opts?: { limit?: number; offset?: number }` | `Promise<AgentRegistryEntry[]>` | *(Optional)* List registered agents with pagination support. |
| `deleteAgent` | `id: string` | `Promise<boolean>` | *(Optional)* Delete an agent by its ID. |

### Example

```typescript
import { InMemoryAgentRegistry } from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();

const researcherId = registry.register({
  name: 'Researcher',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist...',
  temperature: 0.5,
  max_steps: 5,
  tools: [{ type: 'mcp', server_id: 'web-search' }],
  permissions: {
    read_keys: ['topic'],
    write_keys: ['notes']
  },
});
```

## Budget-aware model selection

Instead of hardcoding a model, agents can declare a capability tier via `model_preference`. When a `ModelResolver` is configured on the `GraphRunner`, the engine resolves the tier to a concrete model at runtime — automatically downgrading to cheaper models when the workflow budget is running low.

```typescript
const writerId = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-6',
  model_preference: 'medium',
  provider: 'anthropic',
  system_prompt: 'You write clear summaries.',
  tools: [],
  permissions: {
    read_keys: ['notes'],
    write_keys: ['draft']
  },
});
```

See [Budget-Aware Model Selection](/docs/guides/model-selection/) for the full setup guide.

## Next steps

- [Budget-Aware Model Selection](/docs/guides/model-selection/) — dynamic model selection based on capability tiers and budget
- [Custom LLM Providers](/docs/guides/custom-providers/) — use Groq, Ollama, or any provider; configure `provider_options`
- [Your First Workflow](/docs/guides/first-workflow/) — build an end-to-end workflow
