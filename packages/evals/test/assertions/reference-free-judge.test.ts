import { describe, it, expect } from 'vitest';
import {
  INSTRUCTION_FOLLOWING,
  OUTPUT_QUALITY,
  SAFETY,
  COMPRESSION_FIDELITY,
  QA_ANSWERABILITY,
  REFERENCE_FREE_METRICS,
} from '../../src/assertions/reference-free-judge.js';
import {
  evaluateMetric,
  evaluateSemantics,
} from '../../src/assertions/semantic-judge.js';
import type { SemanticJudgeContext } from '../../src/assertions/semantic-judge.js';

describe('reference-free metrics', () => {
  const contextNoExpected: SemanticJudgeContext = {
    input: 'Explain recursion in programming.',
    actualOutput: 'Recursion is when a function calls itself to solve a problem by breaking it into smaller sub-problems.',
  };

  it('INSTRUCTION_FOLLOWING builds prompt without expectedOutput', () => {
    const prompt = INSTRUCTION_FOLLOWING.buildPrompt(contextNoExpected);

    expect(prompt).toContain(contextNoExpected.input);
    expect(prompt).toContain(contextNoExpected.actualOutput);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('instructions');
  });

  it('OUTPUT_QUALITY builds prompt without expectedOutput', () => {
    const prompt = OUTPUT_QUALITY.buildPrompt(contextNoExpected);

    expect(prompt).toContain(contextNoExpected.input);
    expect(prompt).toContain(contextNoExpected.actualOutput);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('quality');
  });

  it('SAFETY builds prompt referencing only actualOutput', () => {
    const prompt = SAFETY.buildPrompt(contextNoExpected);

    expect(prompt).toContain(contextNoExpected.actualOutput);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('safe');
  });

  it('all reference-free metrics have correct names', () => {
    expect(INSTRUCTION_FOLLOWING.name).toBe('instruction_following');
    expect(OUTPUT_QUALITY.name).toBe('output_quality');
    expect(SAFETY.name).toBe('safety');
  });

  it('evaluateMetric works with reference-free metric and missing expectedOutput', async () => {
    const callJudge = async () => '{"score": 0.85, "reasoning": "Good instruction following"}';

    const result = await evaluateMetric(contextNoExpected, INSTRUCTION_FOLLOWING, callJudge);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.metric).toBe('instruction_following');
  });

  it('evaluateSemantics works with reference-free metrics', async () => {
    const callJudge = async () => '{"score": 0.9, "reasoning": "Passed"}';

    const results = await evaluateSemantics(contextNoExpected, callJudge, {
      metrics: REFERENCE_FREE_METRICS,
    });

    expect(results).toHaveLength(4);
    expect(results.map(r => r.metric)).toEqual([
      'instruction_following',
      'output_quality',
      'safety',
      'compression_fidelity',
    ]);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('prompts do not contain "undefined" or "N/A" when expectedOutput is absent', () => {
    for (const metric of REFERENCE_FREE_METRICS) {
      const prompt = metric.buildPrompt(contextNoExpected);
      expect(prompt).not.toContain('undefined');
      expect(prompt).not.toContain('Expected Output');
    }
  });

  it('REFERENCE_FREE_METRICS array contains all 4 metrics', () => {
    expect(REFERENCE_FREE_METRICS).toHaveLength(4);
    expect(REFERENCE_FREE_METRICS).toContain(INSTRUCTION_FOLLOWING);
    expect(REFERENCE_FREE_METRICS).toContain(OUTPUT_QUALITY);
    expect(REFERENCE_FREE_METRICS).toContain(SAFETY);
    expect(REFERENCE_FREE_METRICS).toContain(COMPRESSION_FIDELITY);
  });
});

describe('QA_ANSWERABILITY', () => {
  const context: SemanticJudgeContext = {
    input: 'What is the deployment budget?',
    actualOutput: 'deployment budget $42,000. Alice approved 2026-03-01.',
    expectedOutput: '$42,000',
  };

  it('has the qa_answerability metric name', () => {
    expect(QA_ANSWERABILITY.name).toBe('qa_answerability');
  });

  it('includes the question, compressed context, and reference answer', () => {
    const prompt = QA_ANSWERABILITY.buildPrompt(context);

    expect(prompt).toContain(context.input);
    expect(prompt).toContain(context.actualOutput);
    expect(prompt).toContain('$42,000');
    expect(prompt).toContain('Reference Answer:');
  });

  it('renders an empty reference answer when expectedOutput is absent', () => {
    const prompt = QA_ANSWERABILITY.buildPrompt({
      input: context.input,
      actualOutput: context.actualOutput,
    });

    expect(prompt).toContain('Reference Answer:');
    expect(prompt).not.toContain('undefined');
  });
});
