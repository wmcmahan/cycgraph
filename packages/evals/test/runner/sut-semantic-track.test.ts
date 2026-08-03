/**
 * Tests for the SUT-driven semantic track.
 *
 * Uses a stub provider whose `callJudge` returns canned JSON scores so
 * the loop can be verified without any real LLM. The SUT itself runs
 * the real deterministic memory library — that's the whole point of
 * the new track.
 */

import { describe, it, expect } from 'vitest';
import { runSutSemanticTrack } from '../../src/runner/sut-semantic-track.js';
import { ANSWER_RELEVANCY, FAITHFULNESS } from '../../src/assertions/semantic-judge.js';
import { loadGoldenTrajectories } from '../../src/dataset/loader.js';
import type { EvalProvider } from '../../src/providers/types.js';
import type { SutSuiteConfig } from '../../src/suites/sut-contract.js';
import type { SuiteName } from '../../src/dataset/types.js';

function stubProvider(scoreSequence: number[]): EvalProvider {
  let i = 0;
  return {
    name: 'stub',
    mode: 'local',
    maxConcurrency: 1,
    callJudge: async () => {
      const score = scoreSequence[Math.min(i++, scoreSequence.length - 1)];
      return JSON.stringify({ score, reasoning: `stub @ ${i}` });
    },
    estimateCost: () => ({ estimatedUsd: 0 }),
  };
}

describe('runSutSemanticTrack — memory suite (deterministic SUT)', () => {
  it('produces a result per test using real library output', async () => {
    const trajectories = loadGoldenTrajectories('memory');
    const segmentation = trajectories.find(t =>
      t.tags?.includes('segmentation') && t.tags?.includes('episodes'),
    );
    expect(segmentation).toBeDefined();

    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: segmentation!.id,
        metrics: [{ metric: ANSWER_RELEVANCY }],
        structuralAssertions: false,
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([0.9, 0.91, 0.89]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 3,
      model: 'irrelevant',
    });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].suite).toBe('memory');
    expect(output.results[0].semanticResults).toHaveLength(1);
    expect(output.results[0].semanticResults[0].passed).toBe(true);
    expect(output.flakyTests).toBeUndefined();
  });

  it('records a failing semantic result when the judge consistently grades low', async () => {
    const trajectories = loadGoldenTrajectories('memory');
    const target = trajectories.find(t => t.tags?.includes('temporal'));
    expect(target).toBeDefined();

    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: target!.id,
        metrics: [{ metric: ANSWER_RELEVANCY }],
        structuralAssertions: false,
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([0.3, 0.32, 0.31]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 3,
      model: 'x',
    });

    expect(output.results[0].semanticResults[0].passed).toBe(false);
    expect(output.results[0].semanticResults[0].score).toBeLessThan(0.5);
    expect(output.flakyTests).toBeUndefined();
  });

  it('flags a test as flaky when judge samples are unstable', async () => {
    const trajectories = loadGoldenTrajectories('memory');
    const target = trajectories[0];

    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: target.id,
        metrics: [{ metric: ANSWER_RELEVANCY }],
        structuralAssertions: false,
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([0.95, 0.3, 0.9]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 3,
      model: 'x',
    });

    expect(output.flakyTests).toBeDefined();
    expect(output.flakyTests![0].suite).toBe('memory');
  });

  it('runs multiple metrics per test', async () => {
    const trajectories = loadGoldenTrajectories('memory');
    const target = trajectories[0];

    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: target.id,
        metrics: [
          { metric: ANSWER_RELEVANCY },
          { metric: FAITHFULNESS },
        ],
        structuralAssertions: false,
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([0.95, 0.96, 0.94, 0.91, 0.92, 0.93]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 3,
      model: 'x',
    });

    expect(output.results[0].semanticResults).toHaveLength(2);
    expect(output.results[0].semanticResults.map(r => r.metric)).toEqual([
      'answer_relevancy',
      'faithfulness',
    ]);
  });
});

describe('every suite exposes buildSutSuite()', () => {
  it('memory suite returns a SUT config', async () => {
    const mod = await import('../../src/suites/memory/suite.js') as {
      buildSutSuite?: () => Promise<{ name: string; tests: unknown[] }>;
    };
    expect(mod.buildSutSuite).toBeDefined();
    const config = await mod.buildSutSuite!();
    expect(config.name).toBe('memory');
    expect(config.tests.length).toBeGreaterThan(0);
  });

  it('context-engine suite returns a SUT config', async () => {
    const mod = await import('../../src/suites/context-engine/suite.js') as {
      buildSutSuite?: () => Promise<{ name: string; tests: unknown[] }>;
    };
    expect(mod.buildSutSuite).toBeDefined();
    const config = await mod.buildSutSuite!();
    expect(config.name).toBe('context-engine');
    expect(config.tests.length).toBeGreaterThan(0);
  });

  it('orchestrator suite returns a SUT config', async () => {
    const mod = await import('../../src/suites/orchestrator/suite.js') as {
      buildSutSuite?: () => Promise<{ name: string; tests: unknown[] }>;
    };
    expect(mod.buildSutSuite).toBeDefined();
    const config = await mod.buildSutSuite!();
    expect(config.name).toBe('orchestrator');
    expect(config.tests.length).toBeGreaterThan(0);
  });

  it('integration suite returns an (empty) SUT config', async () => {
    const mod = await import('../../src/suites/integration/suite.js') as {
      buildSutSuite?: () => Promise<{ name: string; tests: unknown[] }>;
    };
    expect(mod.buildSutSuite).toBeDefined();
    const config = await mod.buildSutSuite!();
    expect(config.name).toBe('integration');
    expect(config.tests).toEqual([]);
  });
});

describe('runSutSemanticTrack — error paths', () => {
  it('records a sut_lookup failure when trajectoryId is unknown', async () => {
    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: '00000000-0000-0000-0000-000000000999',
        metrics: [{ metric: ANSWER_RELEVANCY }],
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([1]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 1,
      model: 'x',
    });

    expect(output.results[0].semanticResults[0].metric).toBe('sut_lookup');
    expect(output.results[0].semanticResults[0].passed).toBe(false);
  });

  it('treats an unloadable suite as zero trajectories and records a lookup failure', async () => {
    const config: SutSuiteConfig = {
      name: 'bogus',
      tests: [{
        trajectoryId: '00000000-0000-0000-0000-000000000001',
        metrics: [{ metric: ANSWER_RELEVANCY }],
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([1]),
      suiteConfigs: [{ suite: 'bogus' as SuiteName, config }],
      samples: 1,
      model: 'x',
    });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].semanticResults[0].metric).toBe('sut_lookup');
  });

  it('emits a synthetic no-op result when a test declares no metrics', async () => {
    const trajectories = loadGoldenTrajectories('memory');
    const target = trajectories[0];

    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [{
        trajectoryId: target.id,
        metrics: [],
        structuralAssertions: false,
      }],
    };

    const output = await runSutSemanticTrack({
      provider: stubProvider([1]),
      suiteConfigs: [{ suite: 'memory', config }],
      samples: 1,
      model: 'x',
    });

    expect(output.results[0].semanticResults).toHaveLength(1);
    expect(output.results[0].semanticResults[0].metric).toBe('no-op');
    expect(output.results[0].semanticResults[0].passed).toBe(true);
  });
});
