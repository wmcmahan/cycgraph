---
title: Eval Assertions
description: The four assertion families in @cycgraph/evals and when to use each.
---

`@cycgraph/evals` ships four kinds of assertion. They differ in what they assume, what they cost, and what failure modes they catch. Pick the family that matches the kind of contract you're guarding.

| Family | Needs LLM? | Catches | Cost |
|--------|-----------|---------|------|
| Structural | No | Wrong tool name, missing required param, type mismatch on tool calls | Free, milliseconds |
| Deterministic | No | Numeric thresholds, set equality, output stability across runs | Free, milliseconds |
| Semantic | Yes | Meaning-level regressions (answer relevancy, faithfulness, coherence) | LLM call per metric per test |
| Reference-free | Yes | Output quality without a comparison reference (safety, instruction-following) | LLM call per metric per test |

## Structural assertions

Validate that an LLM-generated tool call matches the **shape** of an expected call: correct tool name, required parameters present, parameter types match. Values are intentionally *not* compared.

```typescript
import { assertToolCallStructure, assertTrajectoryStructure } from '@cycgraph/evals';

const result = assertToolCallStructure(
  actualCall,    // { toolName: 'web_search', args: { query: '...' } }
  expectedCall,  // golden's expected shape
);
// { passed, toolName, missingParams, typeMismatches }
```

If you supply a Zod schema, it's used. Otherwise the comparison falls back to inferring expectations from the `expected.args` shape. The forgiving behavior is intentional. Natural-language inputs rarely produce verbatim-matching tool args, but the *structure* should be stable.

**Use when** your test is "did the agent call the right tool with the right shape of arguments?"

**Refs:**
- [`assertToolCallStructure`](#asserttoolcallstructure): Validate one tool call structurally.
- [`assertTrajectoryStructure`](#asserttrajectorystructure): Validate a whole tool-call sequence.
- [ZodStructuralResult](#zodstructuralresult): The result shape both return.

## Deterministic assertions

Pure numeric and structural checks with no LLM involvement. The most reliable signal you can get: the same input always produces the same result.

```typescript
import {
  assertGreaterThanOrEqual, assertLessThanOrEqual,
  assertContainsAllKeys, assertSetEquals, assertStable, assertEqual,
} from '@cycgraph/evals';

assertGreaterThanOrEqual('compression_ratio', 0.45, 0.30, '30%+ reduction');
assertSetEquals('retrieved_entities', actual, expected, 'all entities retrieved');
assertStable('format_idempotency', [run1, run2, run3], 'same output every run');
```

Each helper returns a [`DeterministicResult`](#deterministicresult) that feeds into the drift calculator.

**Use when** the contract is numeric or set-based: "compression must save ≥30%", "no duplicates allowed", "segmenter is deterministic across runs".

**Refs:**
- [Deterministic assertions](#deterministic-assertions-1): The six pure-function helpers and their signatures.
- [DeterministicResult](#deterministicresult): The result shape they all return.

## Semantic assertions

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

For CI use, prefer the multi-sample variant. It runs N independent samples and reports stability:

```typescript
import { evaluateMetricMultiSample } from '@cycgraph/evals';

const result = await evaluateMetricMultiSample(
  context, ANSWER_RELEVANCY, callJudge,
  { samples: 3, threshold: 0.8 },
);
// { median, stdDev, samples, stable, passed, reasoning }
```

`stable` is true when `stdDev` stays below the stability ceiling (`0.1` by default). `passed` requires both `stable` AND `median >= threshold`, so a flaky test is *not* a pass. The runner uses this distinction to set exit code 2 on flaky failures so they're attributable.

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

The calibrator averages the absolute deviation between judge scores and the ground-truth scores. When that deviation reaches 0.15 or more, it marks the judge un-calibrated (`isCalibrated: false`) and lowers the pass threshold by the deviation. Wire this into your bootstrap to detect when a model upgrade has shifted the score scale.

**Use when** you need to check meaning rather than structure: "does the answer say roughly the same thing as the expected answer?"

**Refs:**
- [`evaluateMetric`](#evaluatemetric): Run one rubric metric against the judge.
- [`evaluateMetricMultiSample`](#evaluatemetricmultisample): The N-sample stability-aware wrapper.
- [`calibrateJudge`](#calibratejudge) / [`getCalibrationSet`](#getcalibrationset): Detect and correct judge bias.
- [Built-in metrics](#built-in-metrics): The exported `RubricMetric` constants.
- [SemanticJudgeResult](#semanticjudgeresult) / [MultiSampleResult](#multisampleresult): The result shapes.

## Reference-free metrics

Same shape as semantic metrics but scored against the actual output alone, with no `expectedOutput` required. Useful for open-ended generation, safety screening, and instruction-following assessment.

| Metric | What it scores |
|--------|----------------|
| `INSTRUCTION_FOLLOWING` | Does the output follow the input's instructions? |
| `OUTPUT_QUALITY` | Is the output complete, clear, and correct? |
| `SAFETY` | No PII, harmful content, or prompt-injection artifacts? |
| `COMPRESSION_FIDELITY` | How much task-critical information a compressed context preserves. |
| `QA_ANSWERABILITY` | Whether a question is still answerable from a compressed context. |

```typescript
import { INSTRUCTION_FOLLOWING, OUTPUT_QUALITY, SAFETY } from '@cycgraph/evals';
```

`INSTRUCTION_FOLLOWING`, `OUTPUT_QUALITY`, and `SAFETY` are exposed but not yet wired into a default suite. Apply them via `evaluateMetric` or `evaluateMetricMultiSample` the same way as the built-in semantic metrics. `COMPRESSION_FIDELITY` and `QA_ANSWERABILITY` are the exception: the context-engine efficacy track already drives both. The `REFERENCE_FREE_METRICS` array bundles the first four; `QA_ANSWERABILITY` needs a reference answer, so it stays out of that array and is applied on its own.

**Use when** you can't write down an expected answer but you can articulate quality criteria, as is typical of generative endpoints.

**Refs:**
- [Built-in metrics](#built-in-metrics): The exported reference-free `RubricMetric` constants.
- [`evaluateMetric`](#evaluatemetric): The same entry point used for semantic metrics.

## Combining families in a suite

A single trajectory can drive all four kinds of assertion. The [`TestCaseResults`](#testcaseresults) type carries arrays for each:

```typescript
interface TestCaseResults {
  suite: string;
  zodResults: ZodStructuralResult[];        // structural
  semanticResults: SemanticJudgeResult[];   // semantic + reference-free
  deterministicResults?: DeterministicResult[];  // deterministic
}
```

`computeDrift()` treats a test as failed if *any* assertion across the families failed. A test that fails several ways still counts once, so drift stays a true fraction of tests in the 0–100 range. That keeps the gate strict by default, and it's easy to relax per-suite if you need to. See [Drift & Baselines](/docs/concepts/drift-and-baselines/#the-drift-metric) for how the aggregation works.

**Refs:**
- [TestCaseResults](#testcaseresults): The per-test aggregation shape the drift calculator consumes.

## API

### Structural assertions

Both helpers compare tool-call shape only. They never assert exact argument values, and both return a [`ZodStructuralResult`](#zodstructuralresult).

#### `assertToolCallStructure`

Validate a single actual tool call against an expected call: tool name matches, required parameters are present, parameter types match.

```typescript
assertToolCallStructure(
  actual: ToolCall,
  expected: ToolCall,
  argSchema?: ZodType,
): ZodStructuralResult
```

Pass `argSchema` to validate types against a Zod schema. Omit it and the check infers expected types from `expected.args`.

#### `assertTrajectoryStructure`

Validate an ordered tool-call sequence, calling `assertToolCallStructure` once per expected call. A missing call at an index fails that entry with a synthetic `__call_index__` mismatch.

```typescript
assertTrajectoryStructure(
  actualToolCalls: ToolCall[],
  expectedToolCalls: ToolCall[],
): ZodStructuralResult[]
```

### Deterministic assertions

Pure functions with no LLM involvement. Each takes a metric name and a human-readable description and returns a [`DeterministicResult`](#deterministicresult).

| Function | Description |
|----------|-------------|
| `assertGreaterThanOrEqual` | Passes when `actual >= threshold`. For minimum-coverage and compression-ratio floors. |
| `assertLessThanOrEqual` | Passes when `actual <= ceiling`. For budget and latency limits. |
| `assertContainsAllKeys` | Passes when the output string contains every key. For information preservation. |
| `assertSetEquals` | Passes when two string sets are equal. For retrieval precision and subgraph correctness. |
| `assertStable` | Passes when every run serialized identically. For determinism checks. |
| `assertEqual` | Passes when `actual === expected`. For exact counts. |

```typescript
assertGreaterThanOrEqual(metric: string, actual: number, threshold: number, description: string): DeterministicResult
assertLessThanOrEqual(metric: string, actual: number, ceiling: number, description: string): DeterministicResult
assertContainsAllKeys(metric: string, output: string, keys: string[], description: string): DeterministicResult
assertSetEquals(metric: string, actual: Set<string>, expected: Set<string>, description: string): DeterministicResult
assertStable(metric: string, results: unknown[], description: string): DeterministicResult
assertEqual(metric: string, actual: number, expected: number, description: string): DeterministicResult
```

`assertStable` treats fewer than two runs as trivially stable. Everything else compares `JSON.stringify` of each run.

### Semantic judge

Run rubric metrics against a judge LLM. `callJudge` is your function that sends a prompt and returns the raw response text.

#### `evaluateMetric`

Build one metric's prompt, call the judge, parse the response, and compare against the threshold.

```typescript
evaluateMetric(
  context: SemanticJudgeContext,
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  threshold?: number,   // default 0.8
): Promise<SemanticJudgeResult>
```

#### `evaluateSemantics`

Run several metrics against one context and return one result per metric. Defaults to all built-in semantic metrics.

```typescript
evaluateSemantics(
  context: SemanticJudgeContext,
  callJudge: (prompt: string) => Promise<string>,
  options?: SemanticJudgeOptions,
): Promise<SemanticJudgeResult[]>
```

#### `evaluateMetricMultiSample`

Run one metric N times and aggregate median, standard deviation, and stability. This is the CI-facing entry point because it separates flaky failures from genuine regressions.

```typescript
evaluateMetricMultiSample(
  context: SemanticJudgeContext,
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  options?: MultiSampleOptions,
): Promise<MultiSampleResult>
```

#### `parseJudgeResponse`

Parse a judge's raw reply into `{ score, reasoning }`. Handles clean JSON, JSON in a markdown code block, and salvages the numeric score by regex when the surrounding JSON is malformed. Scores are clamped to the 0–1 range.

```typescript
parseJudgeResponse(raw: string): { score: number; reasoning: string }
```

#### `computeMedian` / `computeStdDev`

Stats helpers behind the multi-sample aggregation. `computeStdDev` is the population standard deviation. Both return `0` for empty input.

```typescript
computeMedian(values: number[]): number
computeStdDev(values: number[]): number
```

### Calibration

Detect and correct systematic judge bias before trusting a new model.

#### `calibrateJudge`

Score a set of pre-scored examples with the judge and report the average deviation plus an adjusted threshold. An empty set is treated as calibrated at the base threshold.

```typescript
calibrateJudge(
  calibrationSet: CalibrationExample[],
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  baseThreshold?: number,   // default 0.8
): Promise<CalibrationResult>
```

#### `getCalibrationSet`

Look up a built-in 3-example calibration set by metric name (`answer_relevancy`, `faithfulness`, `logical_coherence`). Returns `[]` for an unknown name.

```typescript
getCalibrationSet(metricName: string): CalibrationExample[]
```

The three sets are also exported directly as `ANSWER_RELEVANCY_CALIBRATION`, `FAITHFULNESS_CALIBRATION`, and `LOGICAL_COHERENCE_CALIBRATION`.

### Built-in metrics

Exported [`RubricMetric`](#rubricmetric) constants. Pass any of them to `evaluateMetric`, `evaluateSemantics`, or `evaluateMetricMultiSample`.

| Constant | Family | Needs `expectedOutput`? |
|----------|--------|-------------------------|
| `ANSWER_RELEVANCY` | Semantic | Yes |
| `FAITHFULNESS` | Semantic | Yes |
| `LOGICAL_COHERENCE` | Semantic | No |
| `INSTRUCTION_FOLLOWING` | Reference-free | No |
| `OUTPUT_QUALITY` | Reference-free | No |
| `SAFETY` | Reference-free | No |
| `COMPRESSION_FIDELITY` | Reference-free | No |
| `QA_ANSWERABILITY` | Reference-free | Yes (reference answer) |

Two array bundles ship as well: `BUILT_IN_METRICS` holds the three semantic metrics and is the default set `evaluateSemantics` uses. `REFERENCE_FREE_METRICS` holds `INSTRUCTION_FOLLOWING`, `OUTPUT_QUALITY`, `SAFETY`, and `COMPRESSION_FIDELITY`.

## Interfaces

### DeterministicResult

Result of a single deterministic assertion. This is an output shape, so it has no defaults.

| Field | Type | Description |
|-------|------|-------------|
| `passed` | `boolean` | Whether the assertion passed. |
| `metric` | `string` | Metric name, for example `compression_ratio`. |
| `expected` | `number` | The threshold or target value. |
| `actual` | `number` | The measured value. |
| `description` | `string` | Human-readable description, annotated with the specific miss on failure. |

### ZodStructuralResult

Result of validating a tool call structurally.

| Field | Type | Description |
|-------|------|-------------|
| `passed` | `boolean` | Whether the tool call passed structural validation. |
| `toolName` | `string` | The expected tool name. |
| `missingParams` | `string[]` | Required parameter names absent from the actual call. |
| `typeMismatches` | `TypeMismatch[]` | Parameters whose types did not match. |

### TypeMismatch

One type mismatch inside a `ZodStructuralResult`.

| Field | Type | Description |
|-------|------|-------------|
| `param` | `string` | Dot-path to the parameter, for example `options.limit`. |
| `expected` | `string` | The type the schema expected. |
| `received` | `string` | The type actually received. |

### SemanticJudgeResult

Result of one LLM-as-judge evaluation.

| Field | Type | Description |
|-------|------|-------------|
| `passed` | `boolean` | Whether the score met the threshold. |
| `score` | `number` | Score from 0.0 (mismatch) to 1.0 (perfect match). |
| `reasoning` | `string` | The judge's explanation of its score. |
| `metric` | `string` | The metric evaluated, for example `answer_relevancy`. |

### MultiSampleResult

Aggregate across N samples of one metric on one test case.

| Field | Type | Description |
|-------|------|-------------|
| `metric` | `string` | Metric name. |
| `median` | `number` | Median score across samples, used as the comparison anchor. |
| `stdDev` | `number` | Standard deviation across samples. |
| `samples` | `number[]` | Raw scores in invocation order. |
| `stable` | `boolean` | True when `stdDev` is below the stability ceiling. |
| `passed` | `boolean` | True only when `median >= threshold` AND `stable`. |
| `reasoning` | `string` | Reasoning from the sample closest to the median. |

### RubricMetric

A rubric metric definition. Each built-in metric constant is one of these.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Metric identifier, for example `answer_relevancy`. |
| `buildPrompt` | `(context: SemanticJudgeContext) => string` | Builds the judge prompt from the eval context. |

### SemanticJudgeContext

The context passed to a metric's prompt builder.

| Field | Type | Description |
|-------|------|-------------|
| `input` | `string` | The original input or query. |
| `actualOutput` | `string` | The output produced by the system under test. |
| `expectedOutput` | `string?` | The golden expected output. Optional for reference-free metrics. |

### SemanticJudgeOptions

Options for `evaluateSemantics`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `threshold` | `number` | `0.8` | Score threshold for passing. |
| `metrics` | `RubricMetric[]` | `BUILT_IN_METRICS` | Metrics to evaluate. |

### MultiSampleOptions

Options for `evaluateMetricMultiSample`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `samples` | `number` | `3` | Independent samples to collect. |
| `threshold` | `number` | `0.8` | Minimum median for a passing result. |
| `stabilityCeiling` | `number` | `0.1` | `stdDev` ceiling above which samples are too variable to trust. |

### CalibrationExample

One pre-scored example for judge calibration. This is input data, so it has no defaults.

| Field | Type | Description |
|-------|------|-------------|
| `input` | `string` | The original input or query. |
| `expectedOutput` | `string` | The reference output. |
| `actualOutput` | `string` | The output to score. |
| `groundTruthScore` | `number` | The human-assigned score this example should receive. |

### CalibrationResult

Result of `calibrateJudge`.

| Field | Type | Description |
|-------|------|-------------|
| `deviation` | `number` | Average absolute deviation between judge scores and ground truth. |
| `adjustedThreshold` | `number` | Pass threshold lowered by the deviation when un-calibrated. |
| `isCalibrated` | `boolean` | True when `deviation` is below 0.15. |

### TestCaseResults

Per-test-case results across all assertion families. Consumed by `computeDrift`.

| Field | Type | Description |
|-------|------|-------------|
| `suite` | `string` | The suite this test belongs to. |
| `zodResults` | `ZodStructuralResult[]` | Structural results for the test's tool calls. Empty if none expected. |
| `semanticResults` | `SemanticJudgeResult[]` | Semantic and reference-free results. Empty if skipped. |
| `deterministicResults` | `DeterministicResult[]?` | Deterministic results. Omitted if skipped. |

## Next steps

- [Eval Harness](/docs/concepts/eval-harness/): overall architecture of the harness
- [Drift & Baselines](/docs/concepts/drift-and-baselines/): how these results aggregate into a drift metric
- [Adding an Eval Suite](/docs/guides/adding-eval-suite/): using these assertions in practice
