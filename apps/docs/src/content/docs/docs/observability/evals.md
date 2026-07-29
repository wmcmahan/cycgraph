---
title: Graph Assertions (runEval)
description: Verify workflow behavior with the orchestrator's built-in per-graph eval framework.
---

Unit tests check *code*: does the function crash? Evals check *behavior*: did the workflow produce the right result? `@cycgraph/orchestrator` includes a built-in lightweight eval framework for defining test cases, running workflows, and asserting on the final state.

:::tip[Looking for the regression harness?]
This page documents `runEval` from `@cycgraph/orchestrator`, a per-graph assertion framework for unit-testing individual workflows. If you're looking for the cross-package regression harness that detects drift across releases, see the [Eval Harness](/docs/concepts/eval-harness/) section.
:::

## Quick start

Define a suite, run it, and inspect the report:

```typescript
import { runEval, EvalSuite } from '@cycgraph/orchestrator';

const suite: EvalSuite = {
  name: 'My First Eval',
  cases: [
    {
      name: 'Research pipeline completes',
      graph: myGraph,
      input: { goal: 'Summarize recent AI news' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'researcher' },
        { type: 'memory_contains', key: 'summary' },
      ],
    },
  ],
};

const report = await runEval(suite);

console.log(`Score: ${report.overall_score}`);   // 0.0–1.0
console.log(`Passed: ${report.passed}/${report.total}`);
```

## How it works

For each case in the suite:

1. **Build state.** `goal`, `constraints`, and `max_token_budget` are extracted from `input`. The entire `input` object is seeded into `memory`.
2. **Run workflow.** A `GraphRunner` executes the graph to completion (or failure/timeout).
3. **Assert.** Each assertion is checked against the final `WorkflowState`.
4. **Score.** Case score = passed assertions / total assertions. Overall score = mean of all case scores.

Cases run sequentially to avoid LLM provider contention. If a workflow crashes, the case gets a score of 0 and an `error` field, and other cases continue unaffected.

**Refs:**
- [`runEval`](#runeval): Run a suite and return the aggregate report.
- [`checkAssertion`](#checkassertion): The per-assertion checker `runCase` calls internally.
- [EvalReport](#evalreport): The aggregate report shape returned by `runEval`.

## Assertion types

Every assertion is a plain object literal of the [`EvalAssertion`](#evalassertion) union, distinguished by its `type` field. All are deterministic except `llm_judge`.

### `status_equals`

Check the workflow's final status:

```typescript
{ type: 'status_equals', expected: 'completed' }
{ type: 'status_equals', expected: 'waiting' }  // for HITL workflows
```

### `node_visited`

Verify a specific node executed:

```typescript
{ type: 'node_visited', node_id: 'researcher' }
```

The check reads `visited_nodes` on the final state.

### `memory_contains`

Check that a key exists in the final state memory:

```typescript
{ type: 'memory_contains', key: 'summary' }
```

The check uses `Object.hasOwn`, so a key named `constructor` or `toString` does not pass through the prototype chain.

### `memory_matches`

Inspect a memory value with three matching modes. `pattern` is always required, so pass an empty string when the mode does not use it:

```typescript
// Exact match (JSON equality)
{ type: 'memory_matches', key: 'count', mode: 'exact', expected: 42, pattern: '' }

// Substring match
{ type: 'memory_matches', key: 'output', mode: 'contains', expected: 'hello', pattern: '' }

// Regex match (against the string value)
{ type: 'memory_matches', key: 'output', mode: 'regex', pattern: '^hello\\s\\w+$' }
```

Regex matches run against at most the first 10,000 characters of a string value, which bounds worst-case matching time.

### `token_budget_respected`

Verify the workflow stayed within its token budget:

```typescript
{ type: 'token_budget_respected' }
```

The check passes when no `max_token_budget` is set, or when `total_tokens_used` is at or below it.

### `llm_judge`

Use an LLM evaluator agent to score the output against criteria. This is the only probabilistic assertion.

```typescript
{
  type: 'llm_judge',
  criteria: 'Is the summary accurate, well-structured, and under 300 words?',
  threshold: 0.75,                    // minimum passing score (0.0–1.0)
  evaluator_agent_id: EVALUATOR_ID,   // UUID of a registered evaluator agent
}
```

The evaluator agent calls `generateText()` with a structured output schema and returns a score (0.0–1.0), reasoning, and optional suggestions. The assertion passes if `score >= threshold`.

**Refs:**
- [EvalAssertion](#evalassertion): The union of every assertion variant and its fields.
- [`checkAssertion`](#checkassertion): How each variant is evaluated against final state.

## Example eval suites

cycgraph ships with three example suites that demonstrate common patterns.

### Linear completion

Tests a 2-node tool pipeline (`fetch` → `transform`):

```typescript
const suite: EvalSuite = {
  name: 'Linear Completion',
  cases: [
    {
      name: 'Two tool nodes complete successfully',
      graph: linearGraph,
      input: { goal: 'Fetch and transform data' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'fetch' },
        { type: 'node_visited', node_id: 'transform' },
        { type: 'memory_contains', key: 'fetch_result' },
        { type: 'memory_contains', key: 'transform_result' },
      ],
    },
  ],
};
```

### Supervisor routing

Tests a router dispatching to a worker:

```typescript
assertions: [
  { type: 'status_equals', expected: 'completed' },
  { type: 'node_visited', node_id: 'router' },
  { type: 'node_visited', node_id: 'worker' },
  { type: 'memory_contains', key: 'worker_result' },
],
```

### Human-in-the-loop approval

Tests that the workflow pauses at an approval gate (status is `waiting`, not `completed`):

```typescript
assertions: [
  { type: 'status_equals', expected: 'waiting' },
  { type: 'node_visited', node_id: 'prepare' },
  { type: 'node_visited', node_id: 'review' },
  { type: 'memory_contains', key: 'prepare_result' },
],
```

### Running the examples

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/linear-completion.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/supervisor-routing.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/hitl-approval.ts
```

## Scoring

- A case with 3/5 passing assertions scores **0.6** and is marked `passed: false`.
- A case with 0 assertions scores **1.0** (all assertions trivially pass).
- The suite's `overall_score` is the mean of all case scores.
- A case that crashes before assertions are checked scores **0** with the error captured in `error`.

## API

### `runEval`

Run an entire eval suite sequentially and produce an aggregate report. Each case builds a fresh `WorkflowState`, executes its graph to a terminal state, then checks every assertion.

```typescript
runEval(suite: EvalSuite): Promise<EvalReport>
```

### `checkAssertion`

Evaluate a single assertion against a terminal workflow state and return a pass/fail result with diagnostics. `runEval` calls this per assertion; it is exported for reuse in custom harnesses.

```typescript
checkAssertion(assertion: EvalAssertion, finalState: WorkflowState): Promise<AssertionResult>
```

`finalState` is a [`WorkflowState`](/docs/concepts/workflow-state/). The `llm_judge` variant is why this returns a `Promise`; the other variants resolve synchronously.

## Interfaces

### EvalSuite

A collection of eval cases to run together.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | — | Human-readable suite name. |
| `cases` | `EvalCase[]` | — | The cases in this suite. |

### EvalCase

A single eval test case.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | — | Human-readable case name. |
| `graph` | [`Graph`](/docs/concepts/graphs/) | — | The graph to execute. |
| `input` | `Record<string, unknown>` | — | Seeded into initial workflow memory. `goal`, `constraints`, and `max_token_budget` are lifted out as top-level state fields. |
| `assertions` | `EvalAssertion[]` | — | Assertions checked against the final state. |
| `agent_configs` | `Record<string, unknown>` | — | Optional agent config overrides. Reserved for future use. |
| `timeout_ms` | `number` | `60000` | Workflow timeout in milliseconds. |

### EvalAssertion

The discriminated union of every assertion variant, keyed on `type`. Authored as plain object literals inside `EvalCase.assertions`.

| `type` | Fields | Checks |
|--------|--------|--------|
| `status_equals` | `expected: string` | Final workflow status equals `expected`. |
| `memory_contains` | `key: string` | `key` is an own property of final memory. |
| `memory_matches` | `key: string`, `pattern: string`, `mode: 'exact' \| 'contains' \| 'regex'`, `expected?: unknown` | Memory value at `key` matches per `mode`. |
| `llm_judge` | `criteria: string`, `threshold: number`, `evaluator_agent_id: string` | LLM evaluator score is at or above `threshold`. |
| `node_visited` | `node_id: string` | `node_id` appears in `visited_nodes`. |
| `token_budget_respected` | *(none)* | `total_tokens_used` stays within `max_token_budget`. |

### AssertionResult

Result of a single assertion check.

| Field | Type | Description |
|-------|------|-------------|
| `assertion` | `EvalAssertion` | The assertion that was checked. |
| `passed` | `boolean` | Whether the assertion passed. |
| `actual` | `unknown` | The observed value, for diagnostics. Omitted on some error paths. |
| `message` | `string` | Human-readable failure message. `undefined` on pass. |

### EvalCaseResult

Result of running a single eval case.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Name of the eval case. |
| `passed` | `boolean` | Whether all assertions passed. |
| `score` | `number` | Fraction of assertions that passed (0.0–1.0). |
| `duration_ms` | `number` | Wall-clock duration in milliseconds. |
| `assertions` | `AssertionResult[]` | Individual assertion results. |
| `error` | `string` | Error message if the workflow crashed before assertions could run. |

### EvalReport

Aggregate report returned by [`runEval`](#runeval).

| Field | Type | Description |
|-------|------|-------------|
| `suite_name` | `string` | Name of the suite. |
| `cases` | `EvalCaseResult[]` | Per-case results. |
| `overall_score` | `number` | Mean score across all cases (0.0–1.0). |
| `total` | `number` | Total number of cases. |
| `passed` | `number` | Number of fully passing cases. |
| `failed` | `number` | Number of cases with at least one failure. |
| `duration_ms` | `number` | Total wall-clock duration in milliseconds. |

## Next steps

- [Tracing](/docs/observability/tracing/): see workflow execution in real-time with OpenTelemetry
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): token and cost budgets
- [Security](/docs/security/): economic guardrails and denial-of-wallet prevention
