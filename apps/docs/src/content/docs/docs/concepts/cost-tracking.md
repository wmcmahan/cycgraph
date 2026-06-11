---
title: Cost & Budget Tracking
description: How cycgraph tracks token usage, calculates costs, and enforces budgets.
---

Every workflow run tracks token consumption and estimated cost in USD. Budgets can be set at the workflow or agent level — the runner enforces them automatically and fails the workflow if limits are exceeded.

## How costs are tracked

Each time a node completes an LLM call, the action metadata includes a `token_usage` breakdown (`inputTokens`, `outputTokens`, `totalTokens`). The reducer accumulates these into two fields on `WorkflowState`:

- **`total_tokens_used`** — cumulative tokens across all LLM calls in the run
- **`total_cost_usd`** — cumulative estimated cost, calculated using the pricing table

Every LLM call is accounted for, not just successful agent nodes:

- **Supervisor routing calls** attach `token_usage` + `model` to their handoff/completion actions, so supervisor loops count toward all budgets.
- **Failed attempts** are counted too — the agent executor attaches best-effort `partialUsage` to its errors, and the runner records it, so a node that retries N times can't hide the tokens it burned on the failed tries.
- **Composite nodes** (evolution, voting, map, annealing) aggregate the token usage of every internal call into their returned action.

Cost is calculated per-model using `calculateCost()`:

```typescript
import { calculateCost, MODEL_PRICING } from '@cycgraph/orchestrator';

const cost = calculateCost('claude-sonnet-4-6', inputTokens, outputTokens);
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
  model: 'claude-opus-4-8',
  // ...
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
    budget_usd: 0.10,
  },
});
```

### Per-node budget

Any node can carry its own `budget: { max_tokens?, max_cost_usd? }`. The runner enforces it after the node completes (breaching either cap throws `NodeBudgetExceededError`).

For **composite nodes** that loop internally (evolution generations, annealing iterations), the post-completion check alone would let the whole population × generations spend happen before the cap is consulted. These nodes now also run an incremental budget guard *between* iterations: once accumulated token/cost spend crosses the node's `budget` or the remaining workflow budget, the loop stops early instead of running every remaining generation. Evolution surfaces a `{nodeId}_budget_stopped` flag in its output envelope. (The runner's hard `NodeBudgetExceededError` still fires if the aggregate exceeded the cap — the guard bounds the overspend, it doesn't suppress the error.)

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

This means a workflow with `budget_usd: 0.50` might start by using `claude-opus-4-8` for early tasks, then automatically switch to `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` as the budget depletes — without any manual intervention.

See [Budget-Aware Model Selection](/docs/guides/model-selection/) for the full setup guide.

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

The `@cycgraph/orchestrator-postgres` package provides `DrizzleUsageRecorder` for durable storage.

## Next steps

- [Workflow State](/docs/concepts/workflow-state/) — where `total_tokens_used` and `total_cost_usd` live
- [Streaming](/docs/concepts/streaming/) — real-time budget threshold events
- [Error Handling](/docs/concepts/error-handling/) — `BudgetExceededError` and recovery
