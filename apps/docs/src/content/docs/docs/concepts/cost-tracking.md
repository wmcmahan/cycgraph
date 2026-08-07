---
title: Cost & Budget Tracking
description: How cycgraph tracks token usage, calculates costs, and enforces budgets.
---

Every workflow run tracks token consumption and estimated cost in USD. Budgets can be set at the workflow or agent level. The runner enforces them automatically and fails the workflow if limits are exceeded.

## How costs are tracked

Each time a node completes an LLM call, the action metadata includes a token usage breakdown, as `inputTokens`, `outputTokens`, and `totalTokens`. The reducer accumulates these into two fields on the [workflow state](/docs/concepts/workflow-state/#cost-and-token-tracking):

- **`total_tokens_used`**: cumulative tokens across all LLM calls in the run
- **`total_cost_usd`**: cumulative estimated cost, calculated using the pricing table

Every LLM call is accounted for, not just successful agent nodes:

- **Supervisor routing calls** attach `token_usage` and `model` to their handoff or completion actions, so supervisor loops count toward all budgets.
- **Failed attempts** are counted too. The agent executor attaches best-effort `partialUsage` to its errors, and the runner records it, so a node that retries N times cannot hide the tokens it burned on the failed tries.
- **Composite nodes** (evolution, voting, map, annealing) aggregate the token usage of every internal call into their returned action.

Calculating costs:

```typescript
import { calculateCost } from '@cycgraph/orchestrator';

const cost = calculateCost('claude-sonnet-4-6', inputTokens, outputTokens);
```

**Refs:**
- [calculateCost](#calculatecost): Estimate USD cost for a model and token counts.
- [MODEL_PRICING](#model_pricing): The static per-model pricing table.
- [Workflow State](/docs/concepts/workflow-state/#cost-and-token-tracking): where `total_tokens_used` and `total_cost_usd` accumulate.

## Setting budgets

### Token budget

Set `maxTokenBudget` on the initial workflow state. The runner throws `BudgetExceededError` when cumulative tokens exceed the limit:

```typescript
state({
  // ...
  maxTokenBudget: 100_000,
});
```

### Cost budget (USD)

Set `budgetUsd` on the initial workflow state. The runner enforces this with threshold alerts and a hard stop at 100%:

```typescript
state({
  // ...
  budgetUsd: 0.50,
});
```

### Agent-level budget

Individual agents can have their own cost cap via `permissions.budgetUsd`:

```typescript
agent({
  // ...
  permissions: {
    budgetUsd: 0.10,
  },
});
```

### Per-node budget

Any node can carry its own budget. The runner enforces it after the node completes, and breaching either cap throws `NodeBudgetExceededError` with no retry.

For composite nodes that loop internally (evolution generations, annealing iterations), the post-completion check alone would let the whole population times generations spend happen before the cap is consulted. These nodes also run an incremental budget guard between iterations: once accumulated token or cost spend crosses the node's budget or the remaining workflow budget, the loop stops early instead of running every remaining generation. Evolution surfaces a `{nodeId}_budget_stopped` flag in its output envelope. The runner's hard `NodeBudgetExceededError` still fires if the aggregate exceeded the cap, so the guard bounds the overspend rather than suppressing the error.

**Refs:**
- [Workflow State](/docs/concepts/workflow-state/#cost-and-token-tracking): the `maxTokenBudget` and `budgetUsd` run-level ceilings.
- [Nodes](/docs/concepts/nodes/#nodebudget): the per-node `NodeBudget` shape (`maxTokens`, `maxCostUsd`).
- [Agents](/docs/concepts/agents/#permissions): the agent `permissions.budgetUsd` cap.
- [Error Handling](/docs/concepts/error-handling/): `BudgetExceededError` and `NodeBudgetExceededError`.

## Budget threshold alerts

When `budgetUsd` is set, the runner emits `budget:threshold_reached` events as cost crosses 50%, 75%, 90%, and 100% of the budget. Each threshold fires only once per run.

```typescript
runner.on('budget:threshold_reached', ({ threshold_pct, cost_usd, budget_usd }) => {
  console.warn(`${threshold_pct}% of $${budget_usd} budget used ($${cost_usd.toFixed(4)})`);
});
```

When streaming, these arrive as `budget:threshold_reached` stream events:

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'budget:threshold_reached') {
    console.warn(`${event.threshold_pct}% budget used`);
  }
}
```

At 100%, the workflow is terminated with `BudgetExceededError` and status transitions to `failed`.

**Refs:**
- [Streaming](/docs/concepts/streaming/#non-terminal-events): the `budget:threshold_reached` event and its `run_id`, `workflow_id`, `threshold_pct`, `cost_usd`, `budget_usd` payload.

## Budget-aware model resolution

When agents use `modelPreference` and a `ModelResolver` is configured, the engine automatically selects the most capable model that fits within the remaining budget. This works hand-in-hand with the budget system described above.

Before each agent execution, the resolver:

1. Estimates the cost of the preferred tier using conservative token budgets
2. Compares against remaining budget (`budgetUsd - total_cost_usd`)
3. Downgrades to a cheaper model if estimated cost exceeds 50% of remaining budget

Each resolution emits a `model:resolved` stream event with one of three reasons:

| Reason | Meaning |
|--------|---------|
| `preferred` | Budget is healthy; agent got its requested tier |
| `budget_downgrade` | Stepped down one tier to conserve budget |
| `budget_critical` | Forced to the lowest tier; budget is nearly exhausted |

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'model:resolved') {
    console.log(`${event.node_id}: ${event.reason} → ${event.resolved_model}`);
  }
}
```

A workflow with `budgetUsd: 0.50` might start by using `claude-opus-4-8` for early tasks, then automatically switch to `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` as the budget depletes, without any manual intervention.

**Refs:**
- [Budget-Aware Model Selection](/docs/guides/model-selection/): the full setup guide for tiers and resolvers.
- [Agents](/docs/concepts/agents/#modeltier): the `modelPreference` capability tier.
- [Streaming](/docs/concepts/streaming/#non-terminal-events): the `model:resolved` event and its payload fields.

## Usage recording

For production billing and reporting, implement the `UsageRecorder` interface to persist per-run usage records. Each record captures token counts, USD cost, and duration for one run, with an optional per-model breakdown. The `@cycgraph/orchestrator-postgres` package provides `DrizzleUsageRecorder` for durable storage.

**Refs:**
- [Persistence](/docs/concepts/persistence/#usagerecorder): the `UsageRecorder` interface and its `saveUsageRecord` method.
- [Persistence](/docs/concepts/persistence/#usagerecord): the `UsageRecord` field table.

## API

Pricing helpers live in `@cycgraph/orchestrator`. They back the cost tracking reducer and budget enforcement, and are exposed so hosts can sync custom pricing at startup.

### `calculateCost`

Estimate the USD cost of an LLM call. Returns `0` for unknown models and logs a warning once per model. Token counts are coerced to finite, non-negative values first.

```typescript
function calculateCost(model: string, inputTokens: number, outputTokens: number): number;
```

### `getModelPricing`

Resolve the effective pricing for a model, checking runtime overrides before the static table. Returns `undefined` for unknown models.

```typescript
function getModelPricing(model: string): ModelPricing | undefined;
```

### `setModelPricing`

Register or update pricing for a single model at runtime. Overrides take precedence over `MODEL_PRICING`. Throws if the values are not finite non-negative numbers.

```typescript
function setModelPricing(model: string, pricing: ModelPricing): void;
```

### `loadPricingTable`

Bulk-register pricing for many models at once, for example a table synced from an external source at host startup. Validates every entry before applying any, so a partially invalid table is rejected atomically.

```typescript
function loadPricingTable(table: Record<string, ModelPricing>): void;
```

### `clearPricingOverrides`

Remove all runtime pricing overrides, leaving the static table in place.

```typescript
function clearPricingOverrides(): void;
```

### `MODEL_PRICING`

The static per-model pricing table, keyed by model id. Prices are in USD per one million tokens.

```typescript
const MODEL_PRICING: Readonly<Record<string, ModelPricing>>;
```

## Interfaces

### ModelPricing

Per-model pricing in USD per one million tokens.

| Field | Type | Description |
|-------|------|-------------|
| `inputPerMToken` | `number` | Cost per 1M input (prompt) tokens. |
| `outputPerMToken` | `number` | Cost per 1M output (completion) tokens. |

### Cross-referenced types

These shapes are owned by other pages. Follow the links for full field tables.

| Type | Documented on |
|------|---------------|
| [`UsageRecord`](/docs/concepts/persistence/#usagerecord) | Persistence: the per-run cost and token record. |
| [`UsageRecorder`](/docs/concepts/persistence/#usagerecorder) | Persistence: the recorder interface. |
| [`WorkflowState`](/docs/concepts/workflow-state/#cost-and-token-tracking) | Workflow State: `maxTokenBudget`, `budgetUsd`, `total_tokens_used`, `total_cost_usd`. |
| [`NodeBudget`](/docs/concepts/nodes/#nodebudget) | Nodes: the per-node `maxTokens` and `maxCostUsd` caps. |

## Next steps

- [Workflow State](/docs/concepts/workflow-state/): where `total_tokens_used` and `total_cost_usd` live
- [Streaming](/docs/concepts/streaming/): real-time budget threshold events
- [Error Handling](/docs/concepts/error-handling/): `BudgetExceededError` and recovery
- [Persistence](/docs/concepts/persistence/): durable usage recording
