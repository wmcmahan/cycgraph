---
title: Cost & Budget Tracking
description: How MC-AI tracks token usage, calculates costs, and enforces budgets.
---

Every workflow run tracks token consumption and estimated cost in USD. Budgets can be set at the workflow or agent level — the runner enforces them automatically and fails the workflow if limits are exceeded.

## How costs are tracked

Each time an agent node completes an LLM call, the action metadata includes a `token_usage` breakdown (`inputTokens`, `outputTokens`, `totalTokens`). The reducer accumulates these into two fields on `WorkflowState`:

- **`total_tokens_used`** — cumulative tokens across all LLM calls in the run
- **`total_cost_usd`** — cumulative estimated cost, calculated using the pricing table

Cost is calculated per-model using `calculateCost()`:

```typescript
import { calculateCost, MODEL_PRICING } from '@mcai/orchestrator';

const cost = calculateCost('claude-sonnet-4-20250514', inputTokens, outputTokens);
// Uses: ($3.00 / 1M input) + ($15.00 / 1M output)
```

Unknown models return `$0` (graceful degradation) and log a warning once.

## Setting budgets

### Token budget

Set `max_token_budget` on the initial workflow state. The runner throws `BudgetExceededError` when cumulative tokens exceed the limit:

```typescript
const state = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Summarize quarterly reports',
  max_token_budget: 100_000,
});
```

### Cost budget (USD)

Set `budget_usd` on the initial workflow state. The runner enforces this with threshold alerts and a hard stop at 100%:

```typescript
const state = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Research and write an article',
  budget_usd: 0.50,
});
```

### Agent-level budget

Individual agents can have their own cost cap via `permissions.budget_usd`:

```typescript
registry.register({
  name: 'Expensive Agent',
  model: 'claude-opus-4-20250514',
  // ...
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
    budget_usd: 0.10,
  },
});
```

## Budget threshold alerts

When `budget_usd` is set, the runner emits `budget:threshold_reached` events as cost crosses 50%, 75%, 90%, and 100% of the budget. Each threshold fires only once per run.

```typescript
runner.on('budget:threshold_reached', ({ threshold_pct, cost_usd, budget_usd }) => {
  console.warn(`${threshold_pct}% of $${budget_usd} budget used ($${cost_usd.toFixed(4)})`);
});
```

When streaming, these arrive as `BudgetThresholdReachedEvent`:

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'budget:threshold_reached') {
    console.warn(`${event.threshold_pct}% budget used`);
  }
}
```

At 100%, the workflow is terminated with `BudgetExceededError` and status transitions to `failed`.

## Budget-aware model resolution

When agents use `model_preference` and a `ModelResolver` is configured, the engine automatically selects the most capable model that fits within the remaining budget. This works hand-in-hand with the budget system described above.

Before each agent execution, the resolver:

1. Estimates the cost of the preferred tier using conservative token budgets
2. Compares against remaining budget (`budget_usd - total_cost_usd`)
3. Downgrades to a cheaper model if estimated cost exceeds 50% of remaining budget

Each resolution emits a `model:resolved` stream event with one of three reasons:

| Reason | Meaning |
|--------|---------|
| `preferred` | Budget is healthy — agent got its requested tier |
| `budget_downgrade` | Stepped down one tier to conserve budget |
| `budget_critical` | Forced to the lowest tier — budget is nearly exhausted |

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'model:resolved') {
    console.log(`${event.node_id}: ${event.reason} → ${event.resolved_model}`);
  }
}
```

This means a workflow with `budget_usd: 0.50` might start by using `claude-opus-4-20250514` for early tasks, then automatically switch to `claude-sonnet-4-20250514` or `claude-haiku-4-5-20251001` as the budget depletes — without any manual intervention.

See [Budget-Aware Model Selection](/guides/model-selection/) for the full setup guide.

## Usage recording

For production billing and reporting, implement the `UsageRecorder` interface to persist per-run usage records:

```typescript
interface UsageRecord {
  run_id: string;
  graph_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}
```

The `@mcai/orchestrator-postgres` package provides `DrizzleUsageRecorder` for durable storage.

## Next steps

- [Workflow State](/concepts/workflow-state/) — where `total_tokens_used` and `total_cost_usd` live
- [Streaming](/concepts/streaming/) — real-time budget threshold events
- [Error Handling](/concepts/error-handling/) — `BudgetExceededError` and recovery
