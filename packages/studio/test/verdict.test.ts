/**
 * Tests for judgeFork (src/run/verdict.ts), which answers whether a fork was
 * an improvement rather than only what it changed.
 */

import { describe, it, expect } from 'vitest';
import { judgeFork, type VerdictInput } from '../src/improve/verdict.js';
import type { AssertionResult } from '@cycgraph/orchestrator';

function assertions(passed: number, total: number): AssertionResult[] {
  return Array.from({ length: total }, (_, i) => ({
    assertion: { type: 'memory_contains', key: `k${i}` } as never,
    passed: i < passed,
  }));
}

function side(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return { status: 'completed', evals: [], costUsd: 0, ...overrides };
}

describe('judgeFork', () => {
  it('calls a fork better when more assertions pass', () => {
    const verdict = judgeFork(
      side({ evals: assertions(2, 4) }),
      side({ evals: assertions(4, 4) }),
    );

    expect(verdict.kind).toBe('better');
    expect(verdict.summary).toContain('4/4 assertions pass, was 2/4');
  });

  it('calls a fork worse when it breaks an assertion', () => {
    const verdict = judgeFork(
      side({ evals: assertions(4, 4) }),
      side({ evals: assertions(3, 4) }),
    );

    expect(verdict.kind).toBe('worse');
  });

  it('calls a rescued failure better', () => {
    const verdict = judgeFork(side({ status: 'failed' }), side({ status: 'completed' }));

    expect(verdict.kind).toBe('better');
    expect(verdict.summary).toContain('completed, was failed');
  });

  it('calls a broken run worse', () => {
    const verdict = judgeFork(side({ status: 'completed' }), side({ status: 'failed' }));

    expect(verdict.kind).toBe('worse');
  });

  it('calls it mixed when one signal improves and another regresses', () => {
    const verdict = judgeFork(
      side({ status: 'failed', evals: assertions(4, 4) }),
      side({ status: 'completed', evals: assertions(1, 4) }),
    );

    expect(verdict.kind).toBe('mixed');
  });

  it('uses a caller score when one is supplied', () => {
    const verdict = judgeFork(side({ score: 0.5 }), side({ score: 0.8 }));

    expect(verdict.kind).toBe('better');
    expect(verdict.summary).toContain('score 0.800, was 0.500');
  });

  it('lets cost decide when the result is provably identical', () => {
    const verdict = judgeFork(side({ costUsd: 0.10 }), side({ costUsd: 0.02 }));

    expect(verdict.kind).toBe('better');
    expect(verdict.summary).toContain('same result, $0.0800 cheaper');
  });

  it('does not let cost decide when the output changed', () => {
    const verdict = judgeFork(
      side({ costUsd: 0.10 }),
      side({ costUsd: 0.02, changedKeys: ['draft'] }),
    );

    expect(verdict.kind).toBe('unclear');
    expect(verdict.summary).toContain('cheaper');
  });

  it('says unchanged when nothing moved at all', () => {
    const verdict = judgeFork(side(), side());

    expect(verdict.kind).toBe('unchanged');
    expect(verdict.summary).toContain('same result');
  });

  it('says unclear when output changed but nothing measures it', () => {
    const verdict = judgeFork(side(), side({ changedKeys: ['draft'] }));

    expect(verdict.kind).toBe('unclear');
    expect(verdict.summary).toContain('draft changed');
    expect(verdict.summary).toContain("evals() block");
  });

  it('names the scenario whose evals block would answer it', () => {
    const verdict = judgeFork(side(), side({ changedKeys: ['draft'] }), {
      scenarioId: 'router-conditions',
    });

    expect(verdict.summary).toContain("router-conditions's evals() block");
    expect(verdict.summary).toContain('llm_judge');
  });

  it('names every reason behind the verdict', () => {
    const verdict = judgeFork(
      side({ status: 'failed', costUsd: 0.10 }),
      side({ status: 'completed', costUsd: 0.02 }),
    );

    expect(verdict.reasons.map(r => r.direction)).toEqual(['better', 'neutral']);
  });
});
