---
title: Budget-Aware Model Selection
description: Automatically select the right model based on capability needs and remaining budget.
---

cycgraph can dynamically choose which LLM model to use for each agent at runtime. Instead of hardcoding a model, agents declare a **capability tier** (`high`, `medium`, or `low`), and the engine resolves it to a concrete model, downgrading automatically when the workflow budget is running low.

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

Set `modelPreference` on the agent. The `model` field still serves as the fallback when no resolver is configured or the tier can't be resolved:

```typescript
import { agent } from '@cycgraph/orchestrator';

const researcher = agent({
  model: 'claude-sonnet-4-6',
  modelPreference: 'high',
  instructions: 'You are a research specialist...',
  tools: [{ mcp: 'web-search' }],
});

const formatter = agent({
  model: 'claude-haiku-4-5-20251001',
  modelPreference: 'low',
  instructions: 'You format text into clean markdown...',
});
```

## Wiring the resolver

With the facade, pass `modelResolver` through `RunOptions.runner`, which forwards extra `GraphRunnerOptions` to the runner `run()` creates:

```typescript
import { run } from '@cycgraph/orchestrator';

const result = await run(workflow, { goal: '...', budgetUsd: 0.50 }, {
  runner: { modelResolver }, 
});
```

On the raw API, pass it via `GraphRunnerOptions` alongside the run-scoped registry and providers:

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';

const runner = new GraphRunner(graph, initialState, {
  registry,
  providers,
  modelResolver,
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
| `preferred` | The agent got its requested tier; budget is healthy |
| `budget_downgrade` | Stepped down one tier to conserve budget |
| `budget_critical` | Forced to the lowest tier; budget is nearly exhausted |

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
  return { reason: 'preferred', model: 'my-custom-model', tier: preference };
};
```

## Complete example

```typescript
import { agent, node, graph, run, defaultModelResolver } from '@cycgraph/orchestrator';
import type { ModelTierMap } from '@cycgraph/orchestrator';

// 1. Define the tier map
const tierMap: ModelTierMap = {
  high:   { anthropic: 'claude-opus-4-8' },
  medium: { anthropic: 'claude-sonnet-4-6' },
  low:    { anthropic: 'claude-haiku-4-5-20251001' },
};

// 2. Define agents with tier preferences
const researcher = agent({
  model: 'claude-sonnet-4-6',
  modelPreference: 'high',
  instructions: 'You research topics thoroughly.',
});

const writer = agent({
  model: 'claude-sonnet-4-6',
  modelPreference: 'medium',
  instructions: 'You write clear, concise summaries.',
});

// 3. Build the graph
const research = node({ id: 'research', agent: researcher, writes: 'research' });
const write    = node({ id: 'write',    agent: writer, reads: [research.writes], writes: 'summary' });

const workflow = graph({
  name: 'Budget-Aware Research',
  description: 'Research a topic, then summarize it under a budget.',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

// 4. Run under a budget with the resolver
const { summary } = await run(workflow, {
  goal: 'Research and summarize quantum computing',
  budgetUsd: 0.50,
}, {
  runner: { modelResolver: defaultModelResolver(tierMap) },
});
```

To observe each `model:resolved` decision as it happens, use the raw runner variant from the wiring section above and consume `runner.stream()`.

## Limitations

- **Architect unaware.** The Workflow Architect does not yet generate graphs with `modelPreference` set, so you must set it on your agent definitions yourself.
- **Single-step lookahead.** The resolver estimates cost for one call at a time, not the remaining workflow.

## Security

- Budget is read **only** from top-level `WorkflowState` fields (`budget_usd`, `total_cost_usd`), never from `memory`. This prevents agents from manipulating their own resolution by writing fake budget values.
- The tier map is frozen at construction time and cannot be mutated at runtime
- All resolver-internal metadata uses `_` prefix keys for bookkeeping

## Next steps

- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): set budgets and monitor spending
- [Custom LLM Providers](/docs/guides/custom-providers/): register providers referenced in your tier map
- [Agents](/docs/concepts/agents/): full agent configuration reference
- [Streaming](/docs/concepts/streaming/): consume `model:resolved` events in real time
