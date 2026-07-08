/**
 * Semantic Judge
 *
 * LLM-as-judge semantic evaluation using structured rubric prompts.
 * Delegates to the active provider (GPT-4o in CI, Ollama locally)
 * via the EvalProvider interface.
 *
 * Each rubric metric is a prompt template that asks the judge to
 * score the output on a 0.0-1.0 scale with reasoning.
 *
 * @module assertions/semantic-judge
 */

import type { SemanticJudgeResult } from './types.js';
import type { EvalProvider } from '../providers/types.js';
import { JUDGE_DATA_PREAMBLE, fenceUntrusted } from './judge-fencing.js';

// ─── Rubric Prompts ────────────────────────────────────────────────

/**
 * A rubric metric definition. Each metric has a name and a function
 * that builds the judge prompt from the eval context.
 */
export interface RubricMetric {
  name: string;
  buildPrompt(context: SemanticJudgeContext): string;
}

/** Context passed to rubric prompt builders. */
export interface SemanticJudgeContext {
  /** The original input/query. */
  input: string;

  /** The actual output produced by the system under test. */
  actualOutput: string;

  /** The expected output from the golden trajectory. Optional for reference-free metrics. */
  expectedOutput?: string;
}

/** Options for running the semantic judge. */
export interface SemanticJudgeOptions {
  /** Score threshold for passing (default: 0.8). */
  threshold?: number;

  /** Specific metrics to evaluate. If omitted, all built-in metrics are used. */
  metrics?: RubricMetric[];
}

// ─── Calibration ──────────────────────────────────────────────────

export interface CalibrationExample {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  groundTruthScore: number;
}

export interface CalibrationResult {
  /** Average absolute deviation between judge scores and ground truth. */
  deviation: number;
  /** Adjusted threshold accounting for judge bias. */
  adjustedThreshold: number;
  /** Whether the judge is considered calibrated (deviation < 0.15). */
  isCalibrated: boolean;
}

/**
 * Calibrate a judge by running it against known-score examples.
 * Returns the average deviation and an adjusted threshold.
 */
export async function calibrateJudge(
  calibrationSet: CalibrationExample[],
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  baseThreshold: number = 0.8,
): Promise<CalibrationResult> {
  if (calibrationSet.length === 0) {
    return {
      deviation: 0,
      adjustedThreshold: baseThreshold,
      isCalibrated: true,
    };
  }

  let totalDeviation = 0;

  for (const example of calibrationSet) {
    const context: SemanticJudgeContext = {
      input: example.input,
      actualOutput: example.actualOutput,
      expectedOutput: example.expectedOutput,
    };

    const result = await evaluateMetric(context, metric, callJudge);
    totalDeviation += Math.abs(result.score - example.groundTruthScore);
  }

  const avgDeviation = totalDeviation / calibrationSet.length;
  const isCalibrated = avgDeviation < 0.15;
  const adjustedThreshold = isCalibrated
    ? baseThreshold
    : baseThreshold - avgDeviation;

  return {
    deviation: avgDeviation,
    adjustedThreshold,
    isCalibrated,
  };
}

// ─── Built-in Rubric Metrics ───────────────────────────────────────

export const ANSWER_RELEVANCY: RubricMetric = {
  name: 'answer_relevancy',
  buildPrompt(ctx) {
    const expectedSection = ctx.expectedOutput
      ? `Expected Output: ${fenceUntrusted(ctx.expectedOutput)}`
      : 'Expected Output: N/A (reference-free evaluation)';

    return [
      'You are an evaluation judge. Score how well the actual output addresses the input query.',
      '',
      JUDGE_DATA_PREAMBLE,
      '',
      `Input: ${fenceUntrusted(ctx.input)}`,
      '',
      expectedSection,
      '',
      `Actual Output: ${fenceUntrusted(ctx.actualOutput)}`,
      '',
      'Score from 0.0 to 1.0 where:',
      '- 1.0 = The actual output fully addresses the input query with equivalent meaning to the expected output',
      '- 0.5 = The actual output partially addresses the query but misses key aspects',
      '- 0.0 = The actual output is completely irrelevant to the input query',
      '',
      '## Examples',
      '',
      'Example 1:',
      'Input: "What is the capital of France?"',
      'Expected: "Paris is the capital of France."',
      'Actual: "The capital of France is Paris, located on the Seine River."',
      'Score: 0.9',
      'Reasoning: "The actual output correctly identifies Paris as the capital and adds relevant geographical detail without introducing errors."',
      '',
      'Example 2:',
      'Input: "What is the capital of France?"',
      'Expected: "Paris is the capital of France."',
      'Actual: "France is a country in Europe with a large population."',
      'Score: 0.2',
      'Reasoning: "The actual output discusses France but fails to answer the specific question about the capital."',
      '',
      'Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<explanation>"}',
    ].join('\n');
  },
};

export const FAITHFULNESS: RubricMetric = {
  name: 'faithfulness',
  buildPrompt(ctx) {
    const expectedSection = ctx.expectedOutput
      ? `Expected Output: ${fenceUntrusted(ctx.expectedOutput)}`
      : 'Expected Output: N/A (reference-free evaluation)';

    return [
      'You are an evaluation judge. Score whether the actual output is factually consistent with the expected output.',
      '',
      JUDGE_DATA_PREAMBLE,
      '',
      expectedSection,
      '',
      `Actual Output: ${fenceUntrusted(ctx.actualOutput)}`,
      '',
      'Score from 0.0 to 1.0 where:',
      '- 1.0 = All facts in the actual output are consistent with the expected output, no contradictions',
      '- 0.5 = Some facts are consistent but there are notable omissions or minor contradictions',
      '- 0.0 = The actual output contradicts the expected output or fabricates facts',
      '',
      '## Examples',
      '',
      'Example 1:',
      'Expected: "Water boils at 100 degrees Celsius at sea level."',
      'Actual: "At standard atmospheric pressure, water reaches its boiling point at 100°C."',
      'Score: 0.9',
      'Reasoning: "The actual output restates the same fact using equivalent terminology. Sea level implies standard atmospheric pressure."',
      '',
      'Example 2:',
      'Expected: "Water boils at 100 degrees Celsius at sea level."',
      'Actual: "Water boils at 50 degrees Celsius under normal conditions."',
      'Score: 0.2',
      'Reasoning: "The actual output contradicts the expected boiling point of water, stating 50°C instead of 100°C."',
      '',
      'Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<explanation>"}',
    ].join('\n');
  },
};

export const LOGICAL_COHERENCE: RubricMetric = {
  name: 'logical_coherence',
  buildPrompt(ctx) {
    return [
      'You are an evaluation judge. Score whether the actual output demonstrates a logically coherent reasoning process.',
      '',
      JUDGE_DATA_PREAMBLE,
      '',
      `Input: ${fenceUntrusted(ctx.input)}`,
      '',
      `Actual Output: ${fenceUntrusted(ctx.actualOutput)}`,
      '',
      'Score from 0.0 to 1.0 where:',
      '- 1.0 = The output follows a clear, logical chain of reasoning with no contradictions',
      '- 0.5 = The output has some logical gaps or minor inconsistencies',
      '- 0.0 = The output is incoherent, self-contradicting, or logically broken',
      '',
      '## Examples',
      '',
      'Example 1:',
      'Input: "Should I use a database index for a frequently queried column?"',
      'Actual: "Yes. Indexes speed up lookups by allowing the database to find rows without scanning the entire table. Since the column is queried frequently, the read performance gain outweighs the minor write overhead."',
      'Score: 0.9',
      'Reasoning: "The output presents a clear premise (indexes speed up lookups), applies it to the context (frequently queried column), and addresses trade-offs (write overhead). The reasoning chain is sound."',
      '',
      'Example 2:',
      'Input: "Should I use a database index for a frequently queried column?"',
      'Actual: "Indexes slow down reads but you should add one because it will speed up your queries. Also, avoid indexing columns you query often."',
      'Score: 0.2',
      'Reasoning: "The output contradicts itself: it says indexes slow reads then claims they speed up queries. It also contradicts the premise by advising against indexing frequently queried columns."',
      '',
      'Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<explanation>"}',
    ].join('\n');
  },
};

/** All built-in rubric metrics. */
export const BUILT_IN_METRICS: RubricMetric[] = [
  ANSWER_RELEVANCY,
  FAITHFULNESS,
  LOGICAL_COHERENCE,
];

// ─── Judge Execution ───────────────────────────────────────────────

/** Schema for parsing the judge's JSON response. */
interface JudgeResponse {
  score: number;
  reasoning: string;
}

/**
 * Parses the judge LLM's response into a score and reasoning.
 * Handles both clean JSON and JSON embedded in markdown code blocks.
 */
export function parseJudgeResponse(raw: string): JudgeResponse {
  // Try to extract JSON from markdown code blocks first
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : raw.trim();

  // Find the first JSON object in the string
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { score: 0, reasoning: `Failed to parse judge response: ${raw.slice(0, 200)}` };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const score = typeof parsed.score === 'number'
      ? Math.max(0, Math.min(1, parsed.score))
      : 0;

    const reasoning = typeof parsed.reasoning === 'string'
      ? parsed.reasoning
      : 'No reasoning provided';

    return { score, reasoning };
  } catch {
    return { score: 0, reasoning: `Failed to parse judge JSON: ${raw.slice(0, 200)}` };
  }
}

/**
 * Runs the semantic judge for a single metric.
 *
 * This function builds the rubric prompt, sends it to the provider,
 * and parses the result. The actual LLM call is delegated to
 * `callJudge`, which must be provided by the caller (typically the
 * runner, which forwards `provider.callJudge`).
 *
 * @param context - The eval context (input, actual output, expected output).
 * @param metric - The rubric metric to evaluate.
 * @param callJudge - Function that sends a prompt to the judge LLM and returns the raw response.
 * @param threshold - Minimum score to pass (default: 0.8).
 */
export async function evaluateMetric(
  context: SemanticJudgeContext,
  metric: RubricMetric,
  callJudge: (prompt: string) => Promise<string>,
  threshold: number = 0.8,
): Promise<SemanticJudgeResult> {
  const prompt = metric.buildPrompt(context);
  const raw = await callJudge(prompt);
  const { score, reasoning } = parseJudgeResponse(raw);

  return {
    passed: score >= threshold,
    score,
    reasoning,
    metric: metric.name,
  };
}

/**
 * Runs all specified metrics (or all built-in metrics) for a single eval case.
 *
 * @param context - The eval context.
 * @param callJudge - Function that sends a prompt to the judge LLM.
 * @param options - Optional configuration (threshold, specific metrics).
 * @returns Array of results, one per metric.
 */
export async function evaluateSemantics(
  context: SemanticJudgeContext,
  callJudge: (prompt: string) => Promise<string>,
  options: SemanticJudgeOptions = {},
): Promise<SemanticJudgeResult[]> {
  const { threshold = 0.8, metrics = BUILT_IN_METRICS } = options;

  return Promise.all(
    metrics.map(metric => evaluateMetric(context, metric, callJudge, threshold)),
  );
}
