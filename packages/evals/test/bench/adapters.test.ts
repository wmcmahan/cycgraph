import { describe, it, expect } from 'vitest';
import {
  createCycgraphAdapter,
  createCycgraphQueryAwareAdapter,
  createCycgraphRelevanceAdapter,
} from '../../src/bench/adapters/cycgraph.js';
import {
  noneAdapter,
  truncationTailAdapter,
  truncationHeadAdapter,
  randomDropAdapter,
} from '../../src/bench/adapters/naive.js';
import { llmlinguaAdapter, nextCalibratedTarget } from '../../src/bench/adapters/llmlingua.js';
import { ADAPTER_REGISTRY, extractAnswer, hashConfig } from '../../src/bench/runner.js';
import { countTokens } from '../../src/bench/token-utils.js';
import { SMOKE_QUESTIONS } from '../../src/bench/dataset/hotpotqa.js';
import type { BenchConfig } from '../../src/bench/types.js';

const question = SMOKE_QUESTIONS[0];

function originalTokensOf(q = question): number {
  return countTokens(q.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'));
}

describe('adapter budget adherence', () => {
  const BUDGET_TOLERANCE = 1.1;
  const internalAdapters = [
    truncationTailAdapter,
    truncationHeadAdapter,
    randomDropAdapter,
    createCycgraphAdapter('fast'),
    createCycgraphAdapter('balanced'),
  ];

  for (const adapter of internalAdapters) {
    it(`${adapter.name} stays within budget`, async () => {
      const budget = Math.ceil(originalTokensOf() * 0.5);

      const output = await adapter.compress(question, budget);

      expect(output.outputTokens).toBeLessThanOrEqual(budget * BUDGET_TOLERANCE);
      expect(output.compressed.length).toBeGreaterThan(0);
    });
  }
});

describe('adapter availability', () => {
  const internalAdapters = [
    noneAdapter,
    truncationTailAdapter,
    truncationHeadAdapter,
    randomDropAdapter,
    createCycgraphAdapter('fast'),
    createCycgraphRelevanceAdapter(),
    createCycgraphQueryAwareAdapter('fast'),
  ];

  for (const adapter of internalAdapters) {
    it(`${adapter.name} is always available`, async () => {
      expect(await adapter.available()).toBe(true);
    });
  }
});

describe('query-aware adapter', () => {
  const BUDGET_TOLERANCE = 1.1;

  it('is labeled distinctly and stays within budget', async () => {
    const adapter = createCycgraphQueryAwareAdapter('fast');
    expect(adapter.name).toBe('cycgraph-fast-query-aware');

    const budget = Math.ceil(originalTokensOf() * 0.4);
    const output = await adapter.compress(question, budget);

    expect(output.outputTokens).toBeLessThanOrEqual(budget * BUDGET_TOLERANCE);
  });

  it('produces different output than the query-agnostic twin at tight budgets', async () => {
    const MIN_DIFFERING = 2;
    let differing = 0;

    for (const qn of SMOKE_QUESTIONS) {
      const budget = Math.ceil(originalTokensOf(qn) * 0.3);
      const agnostic = await createCycgraphAdapter('fast').compress(qn, budget);
      const aware = await createCycgraphQueryAwareAdapter('fast').compress(qn, budget);
      if (aware.compressed !== agnostic.compressed) differing++;
    }

    expect(differing).toBeGreaterThanOrEqual(MIN_DIFFERING);
  });

  it('is deterministic for a fixed question and budget', async () => {
    const adapter = createCycgraphQueryAwareAdapter('fast');

    const a = await adapter.compress(question, 150);
    const b = await adapter.compress(question, 150);

    expect(a.compressed).toBe(b.compressed);
  });
});

describe('relevance-allocation adapter', () => {
  const BUDGET_TOLERANCE = 1.1;

  it('is labeled distinctly, stays within budget, and is deterministic', async () => {
    const adapter = createCycgraphRelevanceAdapter();
    expect(adapter.name).toBe('cycgraph-fast-relevance');

    const budget = Math.ceil(originalTokensOf() * 0.4);
    const a = await adapter.compress(question, budget);
    const b = await adapter.compress(question, budget);

    expect(a.outputTokens).toBeLessThanOrEqual(budget * BUDGET_TOLERANCE);
    expect(a.compressed).toBe(b.compressed);
  });

  it('concentrates budget on the question-relevant document chain', async () => {
    const RELEVANT_RATIO = 0.55;
    const adapter = createCycgraphRelevanceAdapter();

    const output = await adapter.compress(question, Math.ceil(originalTokensOf() * RELEVANT_RATIO));

    expect(output.compressed).toContain('Meridian');
    expect(output.compressed).toContain('Denver');
    expect(output.compressed).not.toContain('directed graphs');
  });
});

describe('adapter determinism', () => {
  it('random-drop is seeded per question (identical across runs)', async () => {
    const a = await randomDropAdapter.compress(question, 100);
    const b = await randomDropAdapter.compress(question, 100);

    expect(a.compressed).toBe(b.compressed);
  });

  it('cycgraph adapters are deterministic', async () => {
    const adapter = createCycgraphAdapter('balanced');

    const a = await adapter.compress(question, 150);
    const b = await adapter.compress(question, 150);

    expect(a.compressed).toBe(b.compressed);
  });
});

describe('naive baselines', () => {
  it('none returns the full context', async () => {
    const output = await noneAdapter.compress(question, Number.MAX_SAFE_INTEGER);

    expect(output.compressed).toContain('Meridian Systems');
    expect(output.compressed).toContain('Denver');
  });

  it('truncation-tail keeps the head; truncation-head keeps the tail', async () => {
    const budget = 60;

    const tail = await truncationTailAdapter.compress(question, budget);
    const head = await truncationHeadAdapter.compress(question, budget);
    const full = (await noneAdapter.compress(question, Number.MAX_SAFE_INTEGER)).compressed;

    expect(full.startsWith(tail.compressed)).toBe(true);
    expect(full.endsWith(head.compressed)).toBe(true);
  });
});

describe('external adapter (llmlingua-2)', () => {
  it('probes availability without throwing', async () => {
    const available = await llmlinguaAdapter.available();

    expect(typeof available).toBe('boolean');
  });

  it('calibration scales the target proportionally toward the budget', () => {
    const next = nextCalibratedTarget(700, 940, 700);

    expect(next).toBeLessThan(700 * (700 / 940));
    expect(next).toBeGreaterThan(400);
  });

  it('calibration converges to a target whose output fits the budget', () => {
    const budget = 500;
    const OVERSHOOT = 1.3;
    let target = 1000;
    let previous = Infinity;

    for (let i = 0; i < 5; i++) {
      const achieved = Math.floor(target * OVERSHOOT);
      target = nextCalibratedTarget(target, achieved, budget);
      expect(target).toBeLessThanOrEqual(previous);
      previous = target;
    }

    expect(Math.floor(target * OVERSHOOT)).toBeLessThanOrEqual(budget);
    expect(target).toBeGreaterThanOrEqual(8);
  });

  it('calibration never returns below the floor', () => {
    expect(nextCalibratedTarget(10, 10_000, 10)).toBe(8);
  });
});

describe('runner helpers', () => {
  it('registry names match the frozen config vocabulary', () => {
    const names = ADAPTER_REGISTRY.map(a => a.name);

    for (const expected of [
      'none',
      'truncation-tail',
      'truncation-head',
      'random-drop',
      'cycgraph-fast',
      'cycgraph-balanced',
      'cycgraph-maximum',
      'llmlingua-2',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('extractAnswer takes the first line and strips an Answer: prefix', () => {
    expect(extractAnswer('\nAnswer: Denver\nBecause...')).toBe('Denver');
    expect(extractAnswer('Denver')).toBe('Denver');
    expect(extractAnswer('')).toBe('');
  });

  it('hashConfig is stable for identical configs and differs when config changes', () => {
    const config: BenchConfig = {
      dataset: 'd',
      datasetUrl: 'u',
      subsetSize: 10,
      seed: 1,
      ratios: [0.5],
      adapters: ['none'],
    };

    expect(hashConfig(config)).toBe(hashConfig({ ...config }));
    expect(hashConfig(config)).not.toBe(hashConfig({ ...config, seed: 2 }));
  });
});
