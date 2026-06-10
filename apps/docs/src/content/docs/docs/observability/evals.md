---
title: Graph Assertions (runEval)
description: Verify workflow behavior with the orchestrator's built-in per-graph eval framework.
---

Unit tests check *code* — does the function crash? Evals check *behavior* — did the workflow produce the right result? `@cycgraph/orchestrator` includes a built-in lightweight eval framework for defining test cases, running workflows, and asserting on the final state.

:::tip[Looking for the regression harness?]
This page documents `runEval` from `@cycgraph/orchestrator` — a per-graph assertion framework for unit-testing individual workflows. If you're looking for the cross-package regression harness that detects drift across releases, see the [Eval Harness](/docs/concepts/eval-harness/) section.
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

1. **Build state** — `goal`, `constraints`, and `max_token_budget` are extracted from `input`. The entire `input` object is seeded into `memory`.
2. **Run workflow** — A `GraphRunner` executes the graph to completion (or failure/timeout).
3. **Assert** — Each assertion is checked against the final `WorkflowState`.
4. **Score** — Case score = passed assertions / total assertions. Overall score = mean of all case scores.

Cases run sequentially to avoid LLM provider contention. If a workflow crashes, the case gets a score of 0 and an `error` field — other cases continue unaffected.

## Assertion types

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

### `memory_contains`

Check that a key exists in the final state memory:

```typescript
{ type: 'memory_contains', key: 'summary' }
```

### `memory_matches`

Inspect a memory value with three matching modes:

```typescript
// Exact match (JSON equality)
{ type: 'memory_matches', key: 'count', mode: 'exact', expected: 42, pattern: '' }

// Substring match
{ type: 'memory_matches', key: 'output', mode: 'contains', expected: 'hello', pattern: '' }

// Regex match (against stringified value)
{ type: 'memory_matches', key: 'output', mode: 'regex', pattern: '^hello\\s\\w+$' }
```

### `token_budget_respected`

Verify the workflow stayed within its token budget:

```typescript
{ type: 'token_budget_respected' }
```

### `llm_judge`

Use an LLM evaluator agent to score the output against criteria. This is the only probabilistic assertion — all others are deterministic.

```typescript
{
  type: 'llm_judge',
  criteria: 'Is the summary accurate, well-structured, and under 300 words?',
  threshold: 0.75,                    // minimum passing score (0.0–1.0)
  evaluator_agent_id: EVALUATOR_ID,   // UUID of a registered evaluator agent
}
```

The evaluator agent calls `generateText()` with a structured output schema and returns a score (0.0–1.0), reasoning, and optional suggestions. The assertion passes if `score >= threshold`.

## EvalSuite structure

```typescript
interface EvalSuite {
  name: string;
  cases: EvalCase[];
}

interface EvalCase {
  name: string;                             // Human-readable case name
  graph: Graph;                             // The graph to execute
  input: Record<string, unknown>;           // Initial memory (goal, constraints, etc.)
  assertions: EvalAssertion[];              // What to check
  timeout_ms?: number;                      // Workflow timeout (default: 60000ms)
}
```

## EvalReport structure

`runEval()` returns a detailed report:

```typescript
interface EvalReport {
  suite_name: string;
  cases: EvalCaseResult[];
  overall_score: number;     // Mean of all case scores (0.0–1.0)
  total: number;             // Total cases
  passed: number;            // Cases where all assertions passed
  failed: number;            // Cases with at least one failure
  duration_ms: number;       // Wall-clock duration
}

interface EvalCaseResult {
  name: string;
  passed: boolean;           // All assertions passed?
  score: number;             // Fraction of assertions that passed
  duration_ms: number;
  assertions: AssertionResult[];
  error?: string;            // Set if workflow crashed
}

interface AssertionResult {
  assertion: EvalAssertion;
  passed: boolean;
  actual?: unknown;          // Observed value
  message?: string;          // Failure explanation
}
```

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

## Next steps

- [Tracing](/docs/observability/tracing/) — see workflow execution in real-time with OpenTelemetry
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/) — token and cost budgets
- [Security](/docs/security/) — economic guardrails and denial-of-wallet prevention
