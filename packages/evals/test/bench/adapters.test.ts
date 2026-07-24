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

describe('adapter budget adherence', () => {
  // Every internal adapter must respect the shared token budget — a cell
  // that overshoots its budget would be comparing apples to oranges.
  const internalAdapters = [
    truncationTailAdapter,
    truncationHeadAdapter,
    randomDropAdapter,
    createCycgraphAdapter('fast'),
    createCycgraphAdapter('balanced'),
  ];

  for (const adapter of internalAdapters) {
    it(`${adapter.name} stays within budget`, async () => {
      const originalTokens = countTokens(
        question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'),
      );
      const budget = Math.ceil(originalTokens * 0.5);
      const output = await adapter.compress(question, budget);
      // Small tolerance: protected tokens / markers can nudge past a soft budget.
      expect(output.outputTokens).toBeLessThanOrEqual(budget * 1.1);
      expect(output.compressed.length).toBeGreaterThan(0);
    });
  }
});

describe('query-aware adapter', () => {
  it('is labeled distinctly and stays within budget', async () => {
    const adapter = createCycgraphQueryAwareAdapter('fast');
    expect(adapter.name).toBe('cycgraph-fast-query-aware');

    const originalTokens = countTokens(
      question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'),
    );
    const budget = Math.ceil(originalTokens * 0.4);
    const output = await adapter.compress(question, budget);
    expect(output.outputTokens).toBeLessThanOrEqual(budget * 1.1);
  });

  it('produces different output than the query-agnostic twin at tight budgets', async () => {
    // The query signal must change what survives for most questions. (For
    // an individual question the query terms can coincide with tokens the
    // base heuristics already keep, so assert across the fixture set.)
    let differing = 0;
    for (const q of SMOKE_QUESTIONS) {
      const originalTokens = countTokens(
        q.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'),
      );
      const budget = Math.ceil(originalTokens * 0.3);
      const agnostic = await createCycgraphAdapter('fast').compress(q, budget);
      const aware = await createCycgraphQueryAwareAdapter('fast').compress(q, budget);
      if (aware.compressed !== agnostic.compressed) differing++;
    }
    expect(differing).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic for a fixed question and budget', async () => {
    const adapter = createCycgraphQueryAwareAdapter('fast');
    const a = await adapter.compress(question, 150);
    const b = await adapter.compress(question, 150);
    expect(a.compressed).toBe(b.compressed);
  });
});

describe('relevance-allocation adapter', () => {
  it('is labeled distinctly, stays within budget, and is deterministic', async () => {
    const adapter = createCycgraphRelevanceAdapter();
    expect(adapter.name).toBe('cycgraph-fast-relevance');

    const originalTokens = countTokens(
      question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'),
    );
    const budget = Math.ceil(originalTokens * 0.4);
    const a = await adapter.compress(question, budget);
    const b = await adapter.compress(question, budget);
    expect(a.outputTokens).toBeLessThanOrEqual(budget * 1.1);
    expect(a.compressed).toBe(b.compressed);
  });

  it('concentrates budget on the question-relevant document chain', async () => {
    // smoke-1 is 2-hop: the question names Meridian Systems; the answer
    // ('Denver') lives in the Northgate doc reachable only via
    // pseudo-relevance feedback. At a budget fitting ~2 of 4 docs, the
    // hop chain gets the budget and the filler docs get none.
    const adapter = createCycgraphRelevanceAdapter();
    const originalTokens = countTokens(
      question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n'),
    );
    const output = await adapter.compress(question, Math.ceil(originalTokens * 0.55));

    expect(output.compressed).toContain('Meridian');   // hop-1: direct match
    expect(output.compressed).toContain('Denver');      // hop-2: via expansion
    // The generic filler doc is dropped entirely
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
    // Whether or not llmlingua is installed, the probe must resolve cleanly
    // so the runner can mark it skipped instead of crashing.
    const available = await llmlinguaAdapter.available();
    expect(typeof available).toBe('boolean');
  });

  it('calibration scales the target proportionally toward the budget', () => {
    // Measured smoke behavior: asked for 700, achieved 940 → next target
    // scales down proportionally with an undershoot bias.
    const next = nextCalibratedTarget(700, 940, 700);
    expect(next).toBeLessThan(700 * (700 / 940)); // bias below the pure ratio
    expect(next).toBeGreaterThan(400);
  });

  it('calibration converges to a target whose output fits the budget', () => {
    const budget = 500;
    let target = 1000;
    let previous = Infinity;
    for (let i = 0; i < 5; i++) {
      // Simulate an engine that always overshoots its target by 30%
      const achieved = Math.floor(target * 1.3);
      target = nextCalibratedTarget(target, achieved, budget);
      expect(target).toBeLessThanOrEqual(previous); // never increases
      previous = target;
    }
    // Fixed point: the converged target's (simulated) output fits the budget
    expect(Math.floor(target * 1.3)).toBeLessThanOrEqual(budget);
    expect(target).toBeGreaterThanOrEqual(8); // floor holds
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
