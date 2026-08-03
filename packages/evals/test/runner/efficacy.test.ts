/**
 * Tests for the context-engine efficacy matrix runner.
 *
 * The compression pipeline is the real `@cycgraph/context-engine` at the
 * current commit, so reduction percentages are genuine. Only the LLM
 * judge is stubbed: `callJudge` returns canned JSON scores, keyed off the
 * metric prompt so fidelity and answerability can be graded independently
 * without any network call.
 */

import { describe, it, expect } from 'vitest';
import { runEfficacyMatrix } from '../../src/runner/efficacy.js';
import type { EvalProvider } from '../../src/providers/types.js';

const SCENARIOS = ['research_session', 'structured_memory'];
const PRESETS = ['fast', 'balanced', 'maximum'];
const CELL_COUNT = SCENARIOS.length * PRESETS.length;

function constantJudge(score: number): EvalProvider {
  return {
    name: 'stub',
    mode: 'local',
    maxConcurrency: 1,
    callJudge: async () => JSON.stringify({ score, reasoning: `constant ${score}` }),
    estimateCost: () => ({ estimatedUsd: 0 }),
  };
}

function discriminatingJudge(fidelityScore: number, answerabilityScore: number): EvalProvider {
  return {
    name: 'stub-split',
    mode: 'local',
    maxConcurrency: 1,
    callJudge: async (prompt: string) => {
      const score = prompt.includes('Question:') ? answerabilityScore : fidelityScore;
      return JSON.stringify({ score, reasoning: `split ${score}` });
    },
    estimateCost: () => ({ estimatedUsd: 0 }),
  };
}

describe('runEfficacyMatrix', () => {
  it('produces one cell per scenario x preset', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 1);

    expect(cells).toHaveLength(CELL_COUNT);
    expect(new Set(cells.map(c => c.scenario))).toEqual(new Set(SCENARIOS));
    expect(new Set(cells.map(c => c.preset))).toEqual(new Set(PRESETS));
  });

  it('records real reduction percentages from the compression pipeline', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 1);

    for (const cell of cells) {
      expect(cell.reductionPercent).toBeGreaterThan(0);
    }
  });

  it('marks a cell passed when fidelity and answerability clear their thresholds', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 1);

    expect(cells.every(c => c.passed)).toBe(true);
    expect(cells.every(c => c.fidelityMedian === 0.9)).toBe(true);
    expect(cells.every(c => c.answerabilityMedian === 0.9)).toBe(true);
  });

  it('fails a cell when fidelity falls below its threshold', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.2), 1);

    expect(cells.every(c => !c.passed)).toBe(true);
    expect(cells.every(c => c.fidelityMedian === 0.2)).toBe(true);
  });

  it('fails a cell when answerability falls below its threshold despite high fidelity', async () => {
    const cells = await runEfficacyMatrix(discriminatingJudge(0.95, 0.3), 1);

    expect(cells.every(c => c.fidelityMedian === 0.95)).toBe(true);
    expect(cells.every(c => c.answerabilityMedian === 0.3)).toBe(true);
    expect(cells.every(c => !c.passed)).toBe(true);
  });

  it('reports one answerability median per QA probe in the scenario', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 1);

    const research = cells.filter(c => c.scenario === 'research_session');
    const structured = cells.filter(c => c.scenario === 'structured_memory');

    expect(research.every(c => c.answerability.length === 4)).toBe(true);
    expect(structured.every(c => c.answerability.length === 3)).toBe(true);
  });

  it('flags every gated preset for the calibrated scenarios', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 1);

    expect(cells.every(c => c.gated)).toBe(true);
  });

  it('reports stable fidelity when repeated samples agree', async () => {
    const cells = await runEfficacyMatrix(constantJudge(0.9), 3);

    expect(cells.every(c => c.fidelityStable)).toBe(true);
  });
});
