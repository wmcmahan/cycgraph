---
title: Agents
description: How agents are defined, configured, and executed in cycgraph.
---

An **Agent** is a configuration that describes how to use an LLM to perform a task: its model, system prompt, tools, and permissions. There are no base classes to extend and no framework to inherit from. You register the config, reference it from an `agent` node by ID, and the runtime turns it into a running agent.

```typescript
import { InMemoryAgentRegistry } from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();

const researcherId = registry.register({
  name: 'Researcher',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You are a research specialist...',
  temperature: 0.5,
  maxSteps: 5,
  tools: [{ type: 'mcp', serverId: 'web-search' }],
});
```

## Agent registry

The registry stores agent configs and hands them to the runtime by ID. `register` auto-generates a UUID and returns it, so a node references an agent through the returned ID rather than a name you manage by hand. `InMemoryAgentRegistry` is the zero-dependency default; `DrizzleAgentRegistry` from `@cycgraph/orchestrator-postgres` is the durable equivalent.

**Refs:**
- [`InMemoryAgentRegistry`](#inmemoryagentregistry): The registry class and its methods.
- [AgentRegistryConfig](#agentregistryconfig): The config shape `register` accepts.

## Model tier preference

Instead of hardcoding a model, an agent can declare a capability tier through `modelPreference`. When a `ModelResolver` is configured on the [`GraphRunner`](/docs/concepts/graph-runner/), the engine resolves the tier to a concrete model at runtime, automatically downgrading to cheaper models when the workflow budget runs low.

```typescript
const writerId = registry.register({
  name: 'Writer',
  modelPreference: 'medium',
  provider: 'anthropic',
  systemPrompt: 'You write clear summaries.',
  tools: [],
});
```

See [Budget-Aware Model Selection](/docs/guides/model-selection/) for the full setup guide.

**Refs:**
- [ModelTier](#modeltier): The capability tiers a preference can name.

## Runtime execution

A registered config becomes a running agent through the agent factory. Wire the registry once at startup with `configureAgentFactory(registry)`. When an `agent` node executes, the factory loads that node's `agentId` from the registry, builds the runtime agent, and the executor runs it against the node's sliced state view.

The factory **fails closed**. An `agentId` that isn't in the registry throws `AgentNotFoundError` rather than silently running a generic deny-all assistant, so a typo'd or deleted ID surfaces as an error. Pass `configureAgentFactory(registry, { allowDefaultFallback: true })` to opt into the legacy default-agent fallback, which is intended for tests and lightweight dev only.

**Refs:**
- [`configureAgentFactory`](#configureagentfactory): Wire the registry into the global factory.

## Permissions

An agent config can carry an optional `permissions` **ceiling** on the memory keys it may read and write. The graph node's `readKeys` / `writeKeys` are the authoritative grant; when a ceiling is present, the effective permission is the intersection of the two. Omitting `permissions` leaves the agent uncapped, so the node's grant alone governs. An explicit empty ceiling still means deny-all, so a deliberately locked-down agent stays locked down wherever it's used. See [State slicing](/docs/concepts/nodes/#state-slicing) for how node grants work.

## API

### `InMemoryAgentRegistry`

Zero-dependency [`AgentRegistry`](/docs/concepts/persistence/#agentregistry) backed by a `Map`, for development and testing. `register` auto-generates a UUID. For production durability, use `DrizzleAgentRegistry` from `@cycgraph/orchestrator-postgres`, which implements the same interface.

```typescript
new InMemoryAgentRegistry()
```

| Method | Description |
|--------|-------------|
| `register(config)` | Register an agent from an [`AgentRegistryConfig`](#agentregistryconfig). Returns the auto-generated UUID. |
| `loadAgent(id)` | Load an [`AgentRegistryEntry`](#agentregistryentry) by ID, or `null` if not found. |
| `updateAgent(id, updates)` | Apply a partial config update. Throws if the agent doesn't exist. |
| `listAgents(opts?)` | List entries with optional `limit` / `offset` pagination. |
| `deleteAgent(id)` | Delete an agent by ID. Returns `true` if it existed. |

`register` and `loadAgent` are required on the [`AgentRegistry`](/docs/concepts/persistence/#agentregistry) contract; `updateAgent`, `listAgents`, and `deleteAgent` are optional, and both shipped implementations provide all five.

### `configureAgentFactory`

Wire a registry into the global agent factory once at startup, so `agent` nodes can load their configs at runtime.

```typescript
configureAgentFactory(registry: AgentRegistry, options?: { allowDefaultFallback?: boolean }): void
```

By default the factory fails closed on an unknown `agentId` (throws `AgentNotFoundError`). Set `allowDefaultFallback: true` to return the generic deny-all default instead, for tests and dev only.

## Interfaces

### AgentRegistryConfig

The camelCase authoring shape accepted by [`register`](#inmemoryagentregistry). Stored entries and `loadAgent` results come back as the snake_case [`AgentRegistryEntry`](#agentregistryentry).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier. Provide one to upsert, or omit to have `register` mint it. |
| `name` | `string` | *required* | Human-readable name. |
| `description` | `string` | `null` | Used by supervisor nodes to route work to this agent. |
| `model` | `string` | *required* | Concrete model id. When `modelPreference` is set with a resolver, that overrides this at runtime. |
| `provider` | `string` | *required* | LLM provider, such as `'anthropic'`, `'openai'`, or `'groq'`. |
| `systemPrompt` | `string` | *required* | System prompt that defines the agent's behavior. |
| `temperature` | `number` | `0.7` | Sampling temperature, from `0.0` (deterministic) to `1.0` (creative). |
| `maxSteps` | `number` | `10` | Safety limit on multi-step tool-execution loops. |
| `tools` | [`ToolSourceConfig[]`](/docs/concepts/tools-and-mcp/) | `[]` | Tool sources available to the agent. |
| `modelPreference` | [`ModelTier`](#modeltier) | — | Capability tier for [budget-aware model selection](/docs/guides/model-selection/). When set and a resolver is configured, overrides `model` at runtime. |
| `providerOptions` | `Record<string, Record<string, JsonValue>>` | — | Provider-specific options, namespaced by provider name. |
| `permissions` | `object` | — | Optional permission ceiling. See [Permissions](#permissions). Fields: `readKeys`, `writeKeys`, optional `sandbox`, optional `budgetUsd`. |

### AgentRegistryEntry

The stored, snake_case form of an agent config, returned by `loadAgent` and `listAgents`. It is the [`AgentRegistryConfig`](#agentregistryconfig) fields with snake_case keys (`system_prompt`, `max_steps`, `model_preference`, `permissions.read_keys`), a guaranteed `id`, and the defaults filled in.

### ModelTier

The capability tier a `modelPreference` can name, resolved to a concrete model at runtime by a `ModelResolver`.

| Value | Use for |
|-------|---------|
| `'high'` | Complex reasoning, planning, code generation. |
| `'medium'` | General-purpose tasks, summarization. |
| `'low'` | Simple formatting, extraction, classification. |

## Next steps

- [Budget-Aware Model Selection](/docs/guides/model-selection/): dynamic model selection based on capability tiers and budget
- [Custom LLM Providers](/docs/guides/custom-providers/): use Groq, Ollama, or any provider, and configure `providerOptions`
- [Nodes](/docs/concepts/nodes/): how `agent` nodes reference and run agents
- [Your First Workflow](/docs/guides/first-workflow/): build an end-to-end workflow
