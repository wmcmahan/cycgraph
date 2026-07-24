import { describe, it, expect } from 'vitest';
import { createOptimizedPipeline } from '@cycgraph/context-engine';
import { runDeterministic } from '../../src/suites/context-engine/suite.js';
import {
  EFFICACY_SCENARIOS,
  joinSegments,
} from '../../src/suites/context-engine/efficacy-fixtures.js';
import {
  COMPRESSION_FIDELITY,
  QA_ANSWERABILITY,
} from '../../src/assertions/reference-free-judge.js';

describe('efficacy fixtures integrity', () => {
  // Guards against fixture drift: a planted fact that never existed in the
  // original would make survival assertions vacuous or unpassable.
  it('every critical fact is present in the original segments', () => {
    for (const scenario of EFFICACY_SCENARIOS) {
      const original = joinSegments(scenario.segments);
      for (const fact of scenario.criticalFacts) {
        expect(original, `${scenario.name}: fact "${fact}" missing from original`).toContain(fact);
      }
      for (const negation of scenario.negations) {
        expect(original, `${scenario.name}: negation "${negation}" missing from original`).toContain(negation);
      }
    }
  });

  it('every scenario has QA probes and gate presets', () => {
    for (const scenario of EFFICACY_SCENARIOS) {
      expect(scenario.qaProbes.length).toBeGreaterThan(0);
      expect(scenario.gatePresets.length).toBeGreaterThan(0);
      expect(scenario.minReductionPercent).toBeGreaterThan(0);
    }
  });
});

describe('efficacy frontier (deterministic track)', () => {
  it('gated presets hit the reduction floor and preserve all facts', async () => {
    const results = await runDeterministic();
    const efficacyResults = results.flatMap(r =>
      (r.deterministicResults ?? []).filter(d => d.metric.startsWith('efficacy_')),
    );

    // 6 gated cells x (reduction + fact survival) + 3 negation checks
    expect(efficacyResults.length).toBeGreaterThanOrEqual(15);
    for (const det of efficacyResults) {
      expect(det.passed, `Failed: ${det.metric} — ${det.description}`).toBe(true);
    }
  });

  it('fast preserves trailing prose facts (importance-aware allocator truncation)', () => {
    // Historical regression guard: before the allocator's importance-aware
    // truncation, `fast` (no CoT distillation, no pruning) lost 3/5 trailing
    // facts to tail truncation at budgets up to 320. The allocator now
    // enforces budgets by token importance, so `fast` is gated like the rest.
    const scenario = EFFICACY_SCENARIOS.find(s => s.name === 'research_session')!;
    expect(scenario.gatePresets).toContain('fast');

    const { pipeline } = createOptimizedPipeline({ preset: 'fast' });
    const result = pipeline.compress({ segments: scenario.segments, budget: scenario.budget });
    const compressed = joinSegments(result.segments);
    const surviving = scenario.criticalFacts.filter(f => compressed.includes(f));

    expect(surviving.length).toBe(scenario.criticalFacts.length);
    for (const negation of scenario.negations) {
      expect(compressed).toContain(negation);
    }
  });
});

describe('efficacy judge metrics', () => {
  const ctx = {
    input: 'The budget is $42,000 approved by Alice.',
    actualOutput: 'budget $42,000 approved Alice',
    expectedOutput: '$42,000',
  };

  it('COMPRESSION_FIDELITY prompt carries original and compressed content', () => {
    const prompt = COMPRESSION_FIDELITY.buildPrompt(ctx);
    expect(prompt).toContain(ctx.input);
    expect(prompt).toContain(ctx.actualOutput);
    expect(prompt).toContain('must NOT be penalized'); // formatting-change guard
    expect(prompt).toContain('{"score": <number>, "reasoning": "<explanation>"}');
  });

  it('QA_ANSWERABILITY prompt carries question, context, and reference answer', () => {
    const prompt = QA_ANSWERABILITY.buildPrompt(ctx);
    expect(prompt).toContain(ctx.input);
    expect(prompt).toContain(ctx.actualOutput);
    expect(prompt).toContain(ctx.expectedOutput);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('{"score": <number>, "reasoning": "<explanation>"}');
  });
});
