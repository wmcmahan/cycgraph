/**
 * Tests for multi-sample semantic evaluation. Uses a programmable judge
 * stub so we can exercise stable / flaky / regressed scenarios without
 * any real LLM calls.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateMetricMultiSample,
  computeMedian,
  computeStdDev,
} from '../../src/runner/multi-sample.js';
import { ANSWER_RELEVANCY } from '../../src/assertions/semantic-judge.js';
import type { SemanticJudgeContext } from '../../src/assertions/semantic-judge.js';

const CONTEXT: SemanticJudgeContext = {
  input: 'What is the capital of France?',
  actualOutput: 'Paris.',
  expectedOutput: 'Paris is the capital of France.',
};

/**
 * Build a judge that returns a sequence of canned scores. Once the
 * sequence is exhausted, the last score is repeated. Each judge call
 * advances by one position.
 */
function programmableJudge(scores: number[]): (prompt: string) => Promise<string> {
  let i = 0;
  return async () => {
    const score = scores[Math.min(i++, scores.length - 1)];
    return JSON.stringify({ score, reasoning: `stub @ sample ${i}` });
  };
}

describe('computeMedian', () => {
  it('returns 0 for an empty array', () => {
    expect(computeMedian([])).toBe(0);
  });

  it('returns the single value for a one-element array', () => {
    expect(computeMedian([0.42])).toBe(0.42);
  });

  it('returns the middle value for odd-length arrays', () => {
    expect(computeMedian([0.1, 0.9, 0.5])).toBe(0.5);
  });

  it('returns the mean of the two middle values for even-length arrays', () => {
    expect(computeMedian([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 5);
  });

  it('is order-independent', () => {
    expect(computeMedian([0.9, 0.1, 0.5])).toBe(computeMedian([0.1, 0.5, 0.9]));
  });
});

describe('computeStdDev', () => {
  it('returns 0 for empty / single-element arrays', () => {
    expect(computeStdDev([])).toBe(0);
    expect(computeStdDev([0.5])).toBe(0);
  });

  it('returns a vanishing residual for identical values', () => {
    expect(computeStdDev([0.8, 0.8, 0.8])).toBeCloseTo(0, 10);
  });

  it('is positive for diverging values', () => {
    expect(computeStdDev([0.1, 0.9, 0.1, 0.9])).toBeGreaterThan(0.3);
  });
});

describe('evaluateMetricMultiSample', () => {
  it('reports passed=true for stable high scores', async () => {
    const judge = programmableJudge([0.9, 0.91, 0.89]);
    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
    );

    expect(result.metric).toBe('answer_relevancy');
    expect(result.samples).toHaveLength(3);
    expect(result.median).toBeCloseTo(0.9, 1);
    expect(result.stable).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('reports stable=false (flaky) when stdDev exceeds the ceiling', async () => {
    const judge = programmableJudge([0.95, 0.2, 0.85]);
    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
    );

    expect(result.stable).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('reports passed=false (regressed) when stable but below threshold', async () => {
    const judge = programmableJudge([0.5, 0.51, 0.49]);
    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
    );

    expect(result.stable).toBe(true);
    expect(result.median).toBeLessThan(0.8);
    expect(result.passed).toBe(false);
  });

  it('honors a custom samples count', async () => {
    const judge = programmableJudge([0.9]);
    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
      { samples: 5 },
    );

    expect(result.samples).toHaveLength(5);
  });

  it('honors a custom threshold', async () => {
    const STABLE_AT_060 = [0.6, 0.62, 0.58];
    const judge = programmableJudge(STABLE_AT_060);
    const withLowerThreshold = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
      { samples: 3, threshold: 0.5 },
    );
    expect(withLowerThreshold.passed).toBe(true);
  });

  it('honors a custom stability ceiling', async () => {
    const STDDEV_ABOVE_DEFAULT_CEILING = [0.95, 0.5, 0.95];
    const judge = programmableJudge(STDDEV_ABOVE_DEFAULT_CEILING);
    const strict = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
      { samples: 3 },
    );
    expect(strict.stable).toBe(false);

    const judge2 = programmableJudge(STDDEV_ABOVE_DEFAULT_CEILING);
    const loose = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge2,
      { samples: 3, stabilityCeiling: 0.3 },
    );
    expect(loose.stable).toBe(true);
  });

  it('picks reasoning from the sample closest to the median', async () => {
    let i = 0;
    const SCORES_MEDIAN_AT_INDEX_2 = [0.1, 0.9, 0.5];
    const judge = async () => {
      const s = SCORES_MEDIAN_AT_INDEX_2[i];
      const reasoning = `reasoning-${i++}`;
      return JSON.stringify({ score: s, reasoning });
    };

    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
    );

    expect(result.reasoning).toBe('reasoning-2');
  });

  it('returns empty reasoning for a zero-sample run', async () => {
    const judge = programmableJudge([0.9]);

    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
      { samples: 0 },
    );

    expect(result.samples).toEqual([]);
    expect(result.median).toBe(0);
    expect(result.reasoning).toBe('');
  });

  it('a single-sample run is a no-variance trivial pass when score is high', async () => {
    const judge = programmableJudge([0.95]);
    const result = await evaluateMetricMultiSample(
      CONTEXT,
      ANSWER_RELEVANCY,
      judge,
      { samples: 1 },
    );

    expect(result.samples).toHaveLength(1);
    expect(result.stdDev).toBe(0);
    expect(result.passed).toBe(true);
  });
});
