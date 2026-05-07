---
title: Agents
description: How agents are defined, configured, and executed in MC-AI.
---

## Agents

MC-AI treats agents as **configuration, not code**. There are no base classes to extend, no framework to inherit from. An agent is a JSON object that the engine feeds into the runtime.

### Agent configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier, returned by `registry.register()`. |
| `name` | `string` | *required* | Human-readable name used in UI and traces. |
| `description` | `string` | — | Used by supervisor nodes to route work to this agent. |
| `model` | `string` | *required* | Model ID (e.g. `'claude-sonnet-4-20250514'`, `'gpt-4o'`). |
| `provider` | `string` | *required* | Provider mapped in `ProviderRegistry` (e.g. `'anthropic'`). |
| `system_prompt` | `string` | *required* | The persona, instructions, and rules for the LLM. |
| `temperature` | `number` | `0.7` | Value between 0.0 (deterministic) and 1.0 (creative). |
| `max_steps` | `number` | `10` | Safety limit for multi-step tool execution loops. |
| `tools` | `ToolSource[]` | `[]` | MCP tools this agent can access (e.g. `[{ type: "mcp", server_id: "github" }]`). |
| `model_preference` | `ModelTier` | — | Capability tier (`'high'`, `'medium'`, `'low'`) for [budget-aware model selection](/guides/model-selection/). When set and a resolver is configured, overrides `model` at runtime. |
| `provider_options` | `object` | — | Provider-specific options passed to `generateText`/`streamText` (e.g. extended thinking). |
| `permissions` | `object` | *required* | Zero-trust state permissions (`read_keys`, `write_keys`). |

## Agent registry

The `AgentRegistry` is a lookup interface to load these configurations into the runtime. You can implement your own (e.g. reading from a database), but the framework provides `InMemoryAgentRegistry` (in `@mcai/orchestrator`) and `DrizzleAgentRegistry` (in `@mcai/orchestrator-postgres`).

```typescript
import { InMemoryAgentRegistry } from '@mcai/orchestrator';

const registry = new InMemoryAgentRegistry();

// register() auto-generates the UUID and returns it
const researcherId = registry.register({
  name: 'Researcher',
  model: 'claude-sonnet-4-20250514',
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

## Runtime execution

When an agent node runs, the **agent executor**:

1. Loads the config from the `AgentRegistry` via the node's `agent_id`
2. Creates a **state view** — a precise slice of `WorkflowState.memory` based on `read_keys`
3. Injects the goal, constraints, and state view into the prompt
4. Streams the LLM execution via `ai` with the configured tools
5. Captures the agent's text output and automatically routes it to the node's write key (or `default_write_key` if specified)
6. Validates write permissions (rejecting writes to restricted keys)
7. Packages the result into an action payload

For agents that need to write structured data to **multiple** memory keys, declare `save_to_memory` explicitly in the agent's `tools` array. Single-key agents do not need it — the orchestrator handles output capture automatically.

All external tool inputs are automatically flagged as **tainted**. The executor propagates this taint to any memory keys written by the agent, ensuring downstream nodes can track the origin of the data.

## Budget-aware model selection

Instead of hardcoding a model, agents can declare a capability tier via `model_preference`. When a `ModelResolver` is configured on the `GraphRunner`, the engine resolves the tier to a concrete model at runtime — automatically downgrading to cheaper models when the workflow budget is running low.

```typescript
const writerId = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',      // fallback if no resolver configured
  model_preference: 'medium',              // resolved at runtime based on budget
  provider: 'anthropic',
  system_prompt: 'You write clear summaries.',
  tools: [],
  permissions: { read_keys: ['notes'], write_keys: ['draft'] },
});
```

See [Budget-Aware Model Selection](/guides/model-selection/) for the full setup guide.

## Next steps

- [Budget-Aware Model Selection](/guides/model-selection/) — dynamic model selection based on capability tiers and budget
- [Custom LLM Providers](/guides/custom-providers/) — use Groq, Ollama, or any provider; configure `provider_options`
- [Your First Workflow](/guides/first-workflow/) — build an end-to-end workflow
