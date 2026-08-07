---
title: Agents
description: How agents are defined, configured, and executed in cycgraph.
---

An **Agent** is a configuration that describes how to use an LLM to perform a task: its model, system prompt, tools, and permissions.

```typescript
import { agent, node } from '@cycgraph/orchestrator';

const researcher = agent({
  model: 'claude-sonnet-4-6',
  instructions: 'You are a research specialist...',
  tools: [{ mcp: 'web-search' }],
});
```

**Refs:**
- [agent](#agent): Define an agent value.
- [AgentSpec](#agentspec): The fields `agent()` accepts.

## Model tier preference

Instead of pinning a model, an agent can declare a capability tier through model preference. When the model resolver is configured on the [runner](/docs/concepts/graph-runner/), the engine resolves the tier to a concrete model at runtime, automatically downgrading to cheaper models when the workflow budget runs low. The model you set is the fallback used when no resolver is present.

```typescript
const writer = agent({
  model: 'claude-sonnet-4-6',
  modelPreference: 'medium',
  instructions: 'You write clear summaries.',
});
```

See [Budget-Aware Model Selection](/docs/guides/model-selection/) for the full setup guide.

**Refs:**
- [ModelTier](#modeltier): The capability tiers a preference can name.

## Runtime execution

A config becomes a running agent through the agent factory. The registry is scoped into the run: `new GraphRunner(graph, state, { registry })` (and `providers` for a custom provider set), which the facade's `run()` does for you. When an `agent` node executes, the factory loads that node's `agentId` from the run's registry, builds the runtime agent, and the executor runs it against the node's sliced state view.

Scoping per run keeps concurrent runs isolated, so two runs with different registries never share state. The older process-global `configureAgentFactory(registry)` is **deprecated** in favor of the `registry` option; it still works for single-tenant setups but mutates state shared across every run in the process.

The factory **fails closed**. An `agentId` that isn't in the registry throws `AgentNotFoundError` rather than silently running a generic deny-all assistant, so a typo'd or deleted id surfaces as an error. Pass `configureAgentFactory(registry, { allowDefaultFallback: true })` to opt into the legacy default-agent fallback, which is intended for tests and lightweight dev only.

**Refs:**
- [`registry` / `providers` options](/docs/operations/configuration/): scope agents and providers into a run.
- [`configureAgentFactory`](#configureagentfactory): deprecated process-global wiring.

## Permissions

State permissions live on the **node**: `node({ reads, writes })` sets the graph node's `readKeys`/`writeKeys`, which are the authoritative grant in the engine. That's why the same agent can run at two nodes with different access.

Separately, a raw registry config can carry an optional `permissions` **ceiling** on the agent itself; when present, the effective permission is the intersection of the node's grant and the ceiling. `agent()` values are uncapped (the node's grant alone governs) — set a ceiling through the registry config when you want an agent locked down wherever it's used. An explicit empty ceiling still means deny-all. See [State slicing](/docs/concepts/nodes/#state-slicing) for how node grants work.

## API

### `agent`

Define an agent as a reusable capability value. Reference it from `node({ agent })` or from any `…AgentId` config field. The provider is inferred from the model name when not given.

```typescript
agent(spec: AgentSpec): AgentValue
```

Throws `AgentSpecError` when the provider can't be inferred and none is supplied. The value expands to an [`AgentRegistryConfig`](#agentregistryconfig): `graph()` mints its registry id (pin one via `spec.id` for deterministic graph JSON) and `run()` registers it automatically — once, however many places reference it.

### `InMemoryAgentRegistry`

Zero-dependency [`AgentRegistry`](/docs/concepts/persistence/#agentregistry) backed by a `Map`, for development and testing. `register` mints a UUID when the config omits an `id`. For production durability, use `DrizzleAgentRegistry` from `@cycgraph/orchestrator-postgres`, which implements the same interface.

```typescript
new InMemoryAgentRegistry()
```

| Method | Description |
|--------|-------------|
| `register(config)` | Register an agent from an [`AgentRegistryConfig`](#agentregistryconfig). Returns the id (auto-generated when omitted). |
| `loadAgent(id)` | Load an [`AgentRegistryEntry`](#agentregistryentry) by ID, or `null` if not found. |
| `updateAgent(id, updates)` | Apply a partial config update. Throws if the agent doesn't exist. |
| `listAgents(opts?)` | List entries with optional `limit` / `offset` pagination. |
| `deleteAgent(id)` | Delete an agent by ID. Returns `true` if it existed. |

`register` and `loadAgent` are required on the [`AgentRegistry`](/docs/concepts/persistence/#agentregistry) contract; `updateAgent`, `listAgents`, and `deleteAgent` are optional, and both shipped implementations provide all five.

### `configureAgentFactory` (deprecated)

**Deprecated** — prefer scoping the registry into the run via `GraphRunnerOptions.registry`. This wires a registry into the *process-global* agent factory, which is shared across every run in the process, so two concurrent runs with different registries contaminate each other. It remains for single-tenant setups until consumers migrate.

```typescript
configureAgentFactory(registry: AgentRegistry, options?: { allowDefaultFallback?: boolean }): void
```

By default the factory fails closed on an unknown `agentId` (throws `AgentNotFoundError`). Set `allowDefaultFallback: true` to return the generic deny-all default instead, for tests and dev only.

## Interfaces

### AgentSpec

The shape accepted by [`agent()`](#agent) — capability fields only; placement (node id, `reads`/`writes`, `memoryQuery`) belongs to `node()`. It maps onto an [`AgentRegistryConfig`](#agentregistryconfig): `instructions` becomes `systemPrompt`, and `provider` is inferred from `model` when omitted.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | *required* | Concrete model id. The provider is inferred from its name. |
| `instructions` | `string` | *required* | System prompt that defines the agent's behavior. |
| `id` | `string` | minted by `graph()` | Pin the registry id (for deterministic graph JSON, e.g. shareable graphs). Usually omitted. |
| `name` | `string` | the id | Human-readable name for registry listings and observability. Routing uses node ids, not agent names. |
| `provider` | `string` | inferred | Override the inferred provider (required for models the inference doesn't cover, e.g. Ollama). |
| `tools` | [`ToolSourceInput[]`](/docs/concepts/tools-and-mcp/) | `[]` | Tool sources: `tool()` values (auto-registered by `run()`), bare names, `{ mcp }` refs, or structured. |
| `temperature` | `number` | `0.7` | Sampling temperature. |
| `maxSteps` | `number` | `10` | Safety limit on multi-step tool loops. |
| `modelPreference` | [`ModelTier`](#modeltier) | — | Capability tier for [budget-aware selection](/docs/guides/model-selection/). |
| `description` | `string` | — | Human-readable description, stored on the registry entry. |
| `providerOptions` | `Record<string, Record<string, JsonValue>>` | — | Provider-specific options, namespaced by provider name. |

### AgentRegistryConfig

The authoring shape accepted by [`register`](#inmemoryagentregistry). An [`agent()`](#agent) value expands to this.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | auto-generated | Unique identifier. Provide one to upsert, or omit to have `register` mint a UUID. A durable Postgres registry requires a UUID; an in-memory registry accepts any string (so the facade's human-readable ids work). |
| `name` | `string` | *required* | Human-readable name. |
| `description` | `string` | `null` | Human-readable description for humans and tooling. |
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

Agent config, returned by `loadAgent` and `listAgents`.

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
