---
title: Eval Assertions
description: The four assertion families in @cycgraph/evals and when to use each.
---

`@cycgraph/evals` ships four kinds of assertion. They differ in what they assume, what they cost, and what failure modes they catch — pick the family that matches the kind of contract you're guarding.

| Family | Needs LLM? | Catches | Cost |
|--------|-----------|---------|------|
| Structural | No | Wrong tool name, missing required param, type mismatch on tool calls | Free, milliseconds |
| Deterministic | No | Numeric thresholds, set equality, output stability across runs | Free, milliseconds |
| Semantic | Yes | Meaning-level regressions (answer relevancy, faithfulness, coherence) | LLM call per metric per test |
| Reference-free | Yes | Output quality without a comparison reference (safety, instruction-following) | LLM call per metric per test |

## 1. Structural assertions

Validate that an LLM-generated tool call matches the **shape** of an expected call — correct tool name, required parameters present, parameter types match. Values are intentionally *not* compared.

```typescript
import { assertToolCallStructure, assertTrajectoryStructure } from '@cycgraph/evals';

const result = assertToolCallStructure(
  actualCall,    // { toolName: 'web_search', args: { query: '...' } }
  expectedCall,  // golden's expected shape
);
// { passed, toolName, missingParams, typeMismatches }
```

If you supply a Zod schema, it's used; otherwise the comparison falls back to inferring expectations from the `expected.args` shape. The forgiving behavior is intentional — natural-language inputs rarely produce verbatim-matching tool args, but the *structure* should be stable.

**Use when** your test is "did the agent call the right tool with the right shape of arguments?"

## 2. Deterministic assertions

Pure numeric and structural checks with no LLM involvement. The most reliable signal you can get — same input always produces the same result.

```typescript
import {
  assertGreaterThanOrEqual, assertLessThanOrEqual,
  assertContainsAllKeys, assertSetEquals, assertStable, assertEqual,
} from '@cycgraph/evals';

assertGreaterThanOrEqual('compression_ratio', 0.45, 0.30, '30%+ reduction');
assertSetEquals('retrieved_entities', actual, expected, 'all entities retrieved');
assertStable('format_idempotency', [run1, run2, run3], 'same output every run');
```

Each helper returns a `DeterministicResult` (`passed`, `metric`, `expected`, `actual`, `description`) that feeds into the drift calculator.

**Use when** the contract is numeric or set-based: "compression must save ≥30%", "no duplicates allowed", "segmenter is deterministic across runs".

## 3. Semantic assertions

LLM-as-judge rubric metrics. Each metric is a prompt template that asks the judge to score the output on a 0.0–1.0 scale with reasoning. Three built-ins:

| Metric | Question it asks |
|--------|------------------|
| `ANSWER_RELEVANCY` | Does the output address the input query? |
| `FAITHFULNESS` | Are the output's claims consistent with the expected output? |
| `LOGICAL_COHERENCE` | Is the reasoning chain logically sound? |

```typescript
import { evaluateMetric, ANSWER_RELEVANCY } from '@cycgraph/evals';

const result = await evaluateMetric(
  { input, actualOutput, expectedOutput },
  ANSWER_RELEVANCY,
  callJudge,           // your judge LLM function
  0.8,                 // pass threshold
);
// { passed, score, reasoning, metric }
```

### Multi-sample wrapping

For CI use, prefer the multi-sample variant — it runs N independent samples and reports stability:

```typescript
import { evaluateMetricMultiSample } from '@cycgraph/evals';

const result = await evaluateMetricMultiSample(
  context, ANSWER_RELEVANCY, callJudge,
  { samples: 3, threshold: 0.8 },
);
// { median, stdDev, samples, stable, passed, reasoning }
```

`stable` is `stdDev < 0.1` by default. `passed` requires both `stable` AND `median >= threshold` — a flaky test is *not* a pass. The runner uses this distinction to set exit code 2 on flaky failures so they're attributable.

### Calibrating the judge

Different LLMs have different score distributions. Calibrate against known-score examples before trusting a new judge:

```typescript
import {
  calibrateJudge, getCalibrationSet, ANSWER_RELEVANCY,
} from '@cycgraph/evals';

const examples = getCalibrationSet('answer_relevancy');  // built-in 3-example set
const result = await calibrateJudge(examples, ANSWER_RELEVANCY, callJudge);
// { deviation, adjustedThreshold, isCalibrated }
```

If `deviation > 0.15`, the calibrator marks the judge as un-calibrated and lowers the pass threshold proportionally. Wire this into your bootstrap to detect when a model upgrade has shifted the score scale.

**Use when** you need to check meaning rather than structure — "does the answer say roughly the same thing as the expected answer?"

## 4. Reference-free metrics

Same shape as semantic metrics but scored against the actual output alone — no `expectedOutput` required. Useful for open-ended generation, safety screening, and instruction-following assessment.

| Metric | What it scores |
|--------|----------------|
| `INSTRUCTION_FOLLOWING` | Does the output follow the input's instructions? |
| `OUTPUT_QUALITY` | Is the output complete, clear, and correct? |
| `SAFETY` | No PII, harmful content, or prompt-injection artifacts? |

```typescript
import { INSTRUCTION_FOLLOWING, OUTPUT_QUALITY, SAFETY } from '@cycgraph/evals';
```

These are exposed but not yet wired into a default suite — see the package roadmap. Apply them via `evaluateMetric` or `evaluateMetricMultiSample` the same way as the built-in semantic metrics.

**Use when** you can't write down an expected answer but you can articulate quality criteria — typical of generative endpoints.

## Combining families in a suite

A single trajectory can drive all four kinds of assertion. The `TestCaseResults` type carries arrays for each:

```typescript
interface TestCaseResults {
  suite: string;
  zodResults: ZodStructuralResult[];        // family 1
  semanticResults: SemanticJudgeResult[];   // families 3 + 4
  deterministicResults?: DeterministicResult[];  // family 2
}
```

`computeDrift()` treats a test as failed if *any* assertion across the families failed. That keeps the gate strict by default — easy to relax per-suite if you need to.

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — overall architecture
- [Drift & Baselines](/docs/concepts/drift-and-baselines/) — how the assertion results aggregate
- [Adding an Eval Suite](/docs/guides/adding-eval-suite/) — using these in practice
