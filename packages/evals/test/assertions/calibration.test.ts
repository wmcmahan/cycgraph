import { describe, it, expect } from 'vitest';
import {
  calibrateJudge,
  ANSWER_RELEVANCY,
} from '../../src/assertions/semantic-judge.js';
import type { CalibrationExample } from '../../src/assertions/semantic-judge.js';

describe('calibrateJudge', () => {
  const calibrationSet: CalibrationExample[] = [
    {
      input: 'What is the capital of France?',
      expectedOutput: 'Paris is the capital of France.',
      actualOutput: 'The capital of France is Paris.',
      groundTruthScore: 0.95,
    },
    {
      input: 'What is 2+2?',
      expectedOutput: '4',
      actualOutput: 'The answer is 4.',
      groundTruthScore: 0.9,
    },
    {
      input: 'Who wrote Hamlet?',
      expectedOutput: 'Shakespeare wrote Hamlet.',
      actualOutput: 'I like pizza.',
      groundTruthScore: 0.1,
    },
  ];

  it('perfect judge: deviation = 0, isCalibrated = true', async () => {
    let callIndex = 0;
    const scores = [0.95, 0.9, 0.1];
    const callJudge = async () => {
      const score = scores[callIndex++];
      return JSON.stringify({ score, reasoning: 'Match' });
    };

    const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBeCloseTo(0, 5);
    expect(result.isCalibrated).toBe(true);
    expect(result.adjustedThreshold).toBe(0.8);
  });

  it('biased judge (consistent +0.4 offset): deviation > 0.15, isCalibrated = false, threshold adjusted', async () => {
    let callIndex = 0;
    const scores = [1.0, 1.0, 0.5];
    const callJudge = async () => {
      const score = scores[callIndex++];
      return JSON.stringify({ score, reasoning: 'Biased' });
    };

    const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBeGreaterThan(0.15);
    expect(result.isCalibrated).toBe(false);
    expect(result.adjustedThreshold).toBeLessThan(0.8);
  });

  it('noisy judge: high deviation, not calibrated', async () => {
    let callIndex = 0;
    const scores = [0.1, 0.1, 0.9]; // Inverted from ground truth
    const callJudge = async () => {
      const score = scores[callIndex++];
      return JSON.stringify({ score, reasoning: 'Noisy' });
    };

    const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBeGreaterThan(0.5);
    expect(result.isCalibrated).toBe(false);
  });

  it('single calibration example', async () => {
    const singleSet: CalibrationExample[] = [{
      input: 'Test',
      expectedOutput: 'Expected',
      actualOutput: 'Actual',
      groundTruthScore: 0.8,
    }];

    const callJudge = async () => '{"score": 0.8, "reasoning": "Match"}';

    const result = await calibrateJudge(singleSet, ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBeCloseTo(0, 5);
    expect(result.isCalibrated).toBe(true);
  });

  it('empty calibration set: deviation 0, calibrated', async () => {
    const callJudge = async () => '{"score": 0.5, "reasoning": "unused"}';

    const result = await calibrateJudge([], ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBe(0);
    expect(result.isCalibrated).toBe(true);
    expect(result.adjustedThreshold).toBe(0.8);
  });

  it('threshold adjustment: adjustedThreshold = baseThreshold - deviation', async () => {
    let callIndex = 0;
    const scores = [0.95 + 0.3, 0.9 + 0.3, 0.1 + 0.3];
    const callJudge = async () => {
      const score = Math.min(1.0, scores[callIndex++]);
      return JSON.stringify({ score, reasoning: 'Off' });
    };

    const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge, 0.8);

    expect(result.isCalibrated).toBe(false);
    expect(result.adjustedThreshold).toBeCloseTo(0.8 - result.deviation, 5);
  });

  it('default base threshold is 0.8', async () => {
    const callJudge = async () => '{"score": 0.5, "reasoning": "unused"}';

    const result = await calibrateJudge([], ANSWER_RELEVANCY, callJudge);

    expect(result.adjustedThreshold).toBe(0.8);
  });

  it('judge that returns unparseable results: deviation is high (score=0)', async () => {
    const callJudge = async () => 'This is not valid JSON at all';

    const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge);

    expect(result.deviation).toBeGreaterThan(0.5);
    expect(result.isCalibrated).toBe(false);
  });
});
