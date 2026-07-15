---
title: Budget-Aware Model Selection
description: Automatically select the right model based on capability needs and remaining budget.
---

cycgraph can dynamically choose which LLM model to use for each agent at runtime. Instead of hardcoding a model, agents declare a **capability tier** (`high`, `medium`, or `low`), and the engine resolves it to a concrete model — downgrading automatically when the workflow budget is running low.

## How it works

1. An agent declares `modelPreference: 'high'` (or `medium` / `low`) instead of relying solely on its static `model` field
2. You provide a **tier map** that maps each tier to concrete models per provider
3. Before each agent execution, the engine's **model resolver** checks the remaining budget and picks the best model the workflow can afford
4. If no resolver is configured, the agent's static `model` is used as a fallback

## Capability tiers

| Tier | Use Case | Example Models |
|------|----------|---------------|
| `high` | Complex reasoning, planning, code generation | `claude-opus-4-8`, `o3` |
| `medium` | General-purpose tasks, summarization | `claude-sonnet-4-6`, `gpt-4o` |
| `low` | Simple formatting, extraction, classification | `claude-haiku-4-5-20251001`, `gpt-4o-mini` |

## Setting up a tier map

A `ModelTierMap` maps each capability tier to concrete model IDs per provider:

```typescript
import { defaultModelResolver } from '@cycgraph/orchestrator';
import type { ModelTierMap } from '@cycgraph/orchestrator';

const tierMap: ModelTierMap = {
  high:   { anthropic: 'claude-opus-4-8',    openai: 'o3' },
  medium: { anthropic: 'claude-sonnet-4-6',  openai: 'gpt-4o' },
  low:    { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' },
};

const modelResolver = defaultModelResolver(tierMap);
```

You only need to include the tiers and providers your workflow uses. If a tier/provider combination is missing, the agent falls back to its static `model`.

## Configuring agents

Set `modelPreference` on the agent config. The `model` field still serves as the fallback when no resolver is configured or the tier can't be resolved:

```typescript
const researcherId = registry.register({
  name: 'Researcher',
  model: 'claude-sonnet-4-6',      // fallback
  modelPreference: 'high',                 // prefers high-tier when budget allows
  provider: 'anthropic',
  systemPrompt: 'You are a research specialist...',
  tools: [{ type: 'mcp', serverId: 'web-search' }],
  permissions: { readKeys: ['topic'], writeKeys: ['notes'] },
});

const formatterId = registry.register({
  name: 'Formatter',
  model: 'claude-haiku-4-5-20251001',      // fallback
  modelPreference: 'low',                   // always use cheapest tier
  provider: 'anthropic',
  systemPrompt: 'You format text into clean markdown...',
  tools: [],
  permissions: { readKeys: ['draft'], writeKeys: ['formatted'] },
});
```

## Wiring the resolver into GraphRunner

Wire the registries globally once at startup, then pass `modelResolver` via `GraphRunnerOptions`:

```typescript
import {
  GraphRunner,
  configureAgentFactory,
  configureProviderRegistry,
} from '@cycgraph/orchestrator';

// Once at startup:
configureProviderRegistry(providers);
configureAgentFactory(registry);

// Per run:
const runner = new GraphRunner(graph, initialState, {
  modelResolver,               // ← budget-aware resolution
});

const finalState = await runner.run();
```

## Budget-aware downgrade logic

The default resolver uses a simple heuristic:

1. **Look up the preferred model** from the tier map for the agent's provider
2. **If no budget is set** → use the preferred model
3. **Estimate the call's cost** using conservative token budgets per tier
4. **If estimated cost < 50% of remaining budget** → use the preferred model (plenty of headroom)
5. **Otherwise, step down one tier** → return the next cheaper model (`high` → `medium`, `medium` → `low`)
6. **If already at the lowest tier** → use it anyway and mark the resolution as `budget_critical`

Each resolution produces one of three reasons:

| Reason | Meaning |
|--------|---------|
| `preferred` | The agent got its requested tier — budget is healthy |
| `budget_downgrade` | Stepped down one tier to conserve budget |
| `budget_critical` | Forced to the lowest tier — budget is nearly exhausted |

## Listening to resolution events

The runner emits `model:resolved` stream events so you can observe every resolution decision:

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'model:resolved') {
    console.log(
      `[${event.node_id}] ${event.reason}: ${event.original_model} → ${event.resolved_model}` +
      (event.remaining_budget_usd !== undefined
        ? ` ($${event.remaining_budget_usd.toFixed(4)} remaining)`
        : '')
    );
  }
}
```

The `ModelResolvedEvent` includes:

| Field | Type | Description |
|-------|------|-------------|
| `reason` | `ModelResolutionReason` | Why this model was chosen |
| `resolved_model` | `string` | The concrete model that will be used |
| `original_model` | `string` | The agent's static fallback model |
| `preference` | `ModelTier` | The agent's declared capability tier |
| `remaining_budget_usd` | `number \| undefined` | Budget remaining at resolution time |

## Cost estimation

The resolver estimates call cost before execution using conservative token budgets:

| Tier | Estimated Input Tokens | Estimated Output Tokens |
|------|----------------------|------------------------|
| `high` | 4,600 | 2,300 |
| `medium` | 2,300 | 1,150 |
| `low` | 1,150 | 575 |

These include a ~15% headroom buffer. If the agent uses Anthropic extended thinking (`providerOptions.anthropic.thinking.budgetTokens`), those tokens are added to the input estimate.

Unknown models are assigned a conservative fallback cost of $0.05 per call (fail-closed).

## Custom resolvers

You can replace the default resolver with any function matching the `ModelResolver` signature:

```typescript
import type { ModelResolver } from '@cycgraph/orchestrator';

const myResolver: ModelResolver = (preference, provider, remainingBudgetUsd) => {
  // Your custom logic here
  // Return ModelResolutionResult or null to fall back to config.model
  return { reason: 'preferred', model: 'my-custom-model', tier: preference };
};
```

## Complete example

```typescript
import {
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryPersistenceProvider,
  createProviderRegistry,
  configureProviderRegistry,
  configureAgentFactory,
  defaultModelResolver,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';
import type { ModelTierMap } from '@cycgraph/orchestrator';

// 1. Set up providers (wired globally)
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// 2. Define the tier map
const tierMap: ModelTierMap = {
  high:   { anthropic: 'claude-opus-4-8' },
  medium: { anthropic: 'claude-sonnet-4-6' },
  low:    { anthropic: 'claude-haiku-4-5-20251001' },
};

// 3. Register agents (wire registry globally)
const registry = new InMemoryAgentRegistry();

const researcherId = registry.register({
  name: 'Researcher',
  model: 'claude-sonnet-4-6',
  modelPreference: 'high',
  provider: 'anthropic',
  systemPrompt: 'You research topics thoroughly.',
  tools: [],
  permissions: { readKeys: ['goal'], writeKeys: ['research'] },
});

const writerId = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-6',
  modelPreference: 'medium',
  provider: 'anthropic',
  systemPrompt: 'You write clear, concise summaries.',
  tools: [],
  permissions: { readKeys: ['research'], writeKeys: ['summary'] },
});

configureAgentFactory(registry);

// 4. Build the graph
const graph = createGraph({
  name: 'Budget-Aware Research',
  description: 'Research a topic, then summarize it under a budget.',
  nodes: [
    { id: 'research', type: 'agent', agentId: researcherId, readKeys: ['goal'], writeKeys: ['research'] },
    { id: 'write',    type: 'agent', agentId: writerId,     readKeys: ['research'], writeKeys: ['summary'] },
  ],
  edges: [{ source: 'research', target: 'write' }],
  startNode: 'research',
  endNodes: ['write'],
});

// 5. Build state and run with the resolver
const persistence = new InMemoryPersistenceProvider();
const state = createWorkflowState({
  workflowId: graph.id,
  goal: 'Research and summarize quantum computing',
  budgetUsd: 0.50,
});

const runner = new GraphRunner(graph, state, {
  modelResolver: defaultModelResolver(tierMap),
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
});

for await (const event of runner.stream()) {
  if (event.type === 'model:resolved') {
    console.log(`${event.node_id}: ${event.reason} → ${event.resolved_model}`);
  }
}
```

## Limitations

- **Architect unaware** — the Workflow Architect does not yet generate graphs with `modelPreference` set; you must configure it via the registry
- **Single-step lookahead** — the resolver estimates cost for one call at a time, not the remaining workflow

## Security

- Budget is read **only** from top-level `WorkflowState` fields (`budget_usd`, `total_cost_usd`), never from `memory` — this prevents agents from manipulating their own resolution by writing fake budget values
- The tier map is frozen at construction time and cannot be mutated at runtime
- All resolver-internal metadata uses `_` prefix keys for bookkeeping

## Next steps

- [Cost & Budget Tracking](/docs/concepts/cost-tracking/) — set budgets and monitor spending
- [Custom LLM Providers](/docs/guides/custom-providers/) — register providers referenced in your tier map
- [Agents](/docs/concepts/agents/) — full agent configuration reference
- [Streaming](/docs/concepts/streaming/) — consume `model:resolved` events in real time
