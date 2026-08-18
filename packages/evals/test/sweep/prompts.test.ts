/**
 * Tests for the prompt-sweep tier (src/sweep/prompts.ts): the brief, the
 * generator instructions, candidate sanitisation, and the sweep they form.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPromptSweep,
  enumerateLeanPromptBrief,
  enumeratePromptBrief,
  renderPromptBrief,
  sanitizePromptCandidates,
} from '../../src/sweep/prompts.js';
import type { PromptBrief } from '../../src/sweep/prompts.js';
import { finding, nodeProfile, supervisorGraph, workflowProfile } from './helpers.js';

const BROKEN = finding({
  id: 'assertion:wf:memory_contains+status_equals',
  detector: 'assertions',
  severity: 'high',
  title: 'wf fails 2 assertions together: memory_contains, status_equals',
  detail: '30 of 36 runs (83%) — Memory does not contain key "final"',
});

const DOMINANT = nodeProfile({ nodeId: 'boss', type: 'supervisor' });

function brief(partial: Partial<PromptBrief> = {}): PromptBrief {
  return {
    workflow: 'wf',
    nodeId: 'boss',
    intent: 'repair',
    evidence: '30 of 36 runs (83%) — Memory does not contain key "final"',
    reason: 'r',
    ...partial,
  };
}

describe('enumeratePromptBrief', () => {
  it('produces a brief for a workflow failing most runs', () => {
    const result = enumeratePromptBrief([BROKEN], workflowProfile([DOMINANT]), supervisorGraph());

    expect(result?.nodeId).toBe('boss');
    expect(result?.evidence).toContain('Memory does not contain key "final"');
  });

  it('says which node it chose and why', () => {
    const result = enumeratePromptBrief([BROKEN], workflowProfile([DOMINANT]), supervisorGraph());

    expect(result?.reason).toContain("'boss'");
    expect(result?.reason).toContain('fails its assertions in most runs');
  });

  it('leaves an intermittent failure to the temperature tier', () => {
    const flaky = finding({ id: BROKEN.id, detector: 'assertions', severity: 'medium' });

    expect(enumeratePromptBrief([flaky], workflowProfile([DOMINANT]), supervisorGraph())).toBeUndefined();
  });

  it('stays silent when the workflow holds its assertions', () => {
    expect(enumeratePromptBrief([], workflowProfile([DOMINANT]), supervisorGraph())).toBeUndefined();
  });

  it('stays silent when no agent-backed node dominates', () => {
    const small = workflowProfile([nodeProfile({ nodeId: 'boss', timeShare: 0.05 })]);

    expect(enumeratePromptBrief([BROKEN], small, supervisorGraph())).toBeUndefined();
  });

  it('stays silent without a profile to pick a node from', () => {
    expect(enumeratePromptBrief([BROKEN], undefined, supervisorGraph())).toBeUndefined();
  });
});

describe('enumerateLeanPromptBrief', () => {
  const CHECKS = ['status_equals', 'memory_contains'];

  it('produces a lean brief for a healthy workflow with a dominant agent node', () => {
    const result = enumerateLeanPromptBrief([], workflowProfile([DOMINANT]), supervisorGraph(), CHECKS);

    expect(result?.intent).toBe('lean');
    expect(result?.nodeId).toBe('boss');
  });

  it('names the share and visit count that motivated it', () => {
    const result = enumerateLeanPromptBrief([], workflowProfile([DOMINANT]), supervisorGraph(), CHECKS);

    expect(result?.reason).toContain('66% of execution time across 4.2 visit(s)');
  });

  it('carries the checks the rewrite must keep passing', () => {
    const result = enumerateLeanPromptBrief([], workflowProfile([DOMINANT]), supervisorGraph(), CHECKS);

    expect(result?.evidence).toBe('the checks that must keep passing: memory_contains, status_equals');
  });

  it('yields to repair when the workflow is broken', () => {
    const result = enumerateLeanPromptBrief([BROKEN], workflowProfile([DOMINANT]), supervisorGraph(), CHECKS);

    expect(result).toBeUndefined();
  });

  it('stays silent when no checks exist to preserve', () => {
    expect(enumerateLeanPromptBrief([], workflowProfile([DOMINANT]), supervisorGraph(), [])).toBeUndefined();
  });

  it('stays silent when no agent-backed node dominates', () => {
    const small = workflowProfile([nodeProfile({ nodeId: 'boss', timeShare: 0.05 })]);

    expect(enumerateLeanPromptBrief([], small, supervisorGraph(), CHECKS)).toBeUndefined();
  });
});

describe('renderPromptBrief', () => {
  it('hands the generator the current prompt verbatim', () => {
    const text = renderPromptBrief(brief(), 'You are a research supervisor.', 2);

    expect(text).toContain('You are a research supervisor.');
  });

  it('hands the generator the failing assertions as the contract', () => {
    const text = renderPromptBrief(brief(), 'p', 2);

    expect(text).toContain('Memory does not contain key "final"');
  });

  it('asks for exactly the requested count in JSON', () => {
    const text = renderPromptBrief(brief(), 'p', 3);

    expect(text).toContain('{"prompts": ["...", ...]}');
    expect(text).toContain('exactly 3 entries');
  });

  it('reads naturally for a single candidate', () => {
    expect(renderPromptBrief(brief(), 'p', 1)).toContain('exactly 1 entry');
  });

  it('asks a lean brief for shorter prompts that preserve the checks', () => {
    const text = renderPromptBrief(
      brief({ intent: 'lean', evidence: 'the checks that must keep passing: status_equals' }),
      'p',
      2,
    );

    expect(text).toContain('substantially leaner');
    expect(text).toContain('the checks that must keep passing: status_equals');
    expect(text).toContain('The workflow already succeeds');
  });
});

describe('sanitizePromptCandidates', () => {
  it('accepts the requested object shape', () => {
    const survivors = sanitizePromptCandidates('current', { prompts: ['alpha', 'beta'] }, 2);

    expect(survivors).toEqual(['alpha', 'beta']);
  });

  it('accepts a bare array', () => {
    expect(sanitizePromptCandidates('current', ['alpha'], 2)).toEqual(['alpha']);
  });

  it('drops a candidate identical to the current prompt', () => {
    const survivors = sanitizePromptCandidates('current', { prompts: ['  current ', 'alpha'] }, 2);

    expect(survivors).toEqual(['alpha']);
  });

  it('drops empty and non-string entries', () => {
    const survivors = sanitizePromptCandidates('current', { prompts: ['', 42, 'alpha', null] }, 3);

    expect(survivors).toEqual(['alpha']);
  });

  it('drops a runaway-length candidate', () => {
    const survivors = sanitizePromptCandidates('current', { prompts: ['x'.repeat(5000), 'alpha'] }, 2);

    expect(survivors).toEqual(['alpha']);
  });

  it('deduplicates and caps at the requested count', () => {
    const survivors = sanitizePromptCandidates('current', { prompts: ['a', 'a', 'b', 'c'] }, 2);

    expect(survivors).toEqual(['a', 'b']);
  });

  it('survives garbage output entirely', () => {
    expect(sanitizePromptCandidates('current', 'not json shaped', 2)).toEqual([]);
    expect(sanitizePromptCandidates('current', null, 2)).toEqual([]);
  });
});

describe('buildPromptSweep', () => {
  it('makes the current prompt the control arm', () => {
    const sweep = buildPromptSweep(brief(), 'the current prompt', ['alpha']);

    expect(sweep!.control).toBe('prompt=current');
    expect(sweep!.variants['prompt=current']).toEqual([
      { kind: 'prompt', target: 'boss', system_prompt: 'the current prompt' },
    ]);
  });

  it('turns each candidate into a prompt change', () => {
    const sweep = buildPromptSweep(brief(), 'current', ['alpha', 'beta']);

    expect(sweep!.variants['prompt=v2']).toEqual([
      { kind: 'prompt', target: 'boss', system_prompt: 'beta' },
    ]);
  });

  it('makes a repair brief a sampled reliability sweep over failing prefixes', () => {
    const sweep = buildPromptSweep(brief(), 'current', ['alpha']);

    expect(sweep!.objective).toBe('reliability');
    expect(sweep!.prefixes).toBe('failing');
    expect(sweep!.samples).toBe(5);
  });

  it('makes a lean brief a sampled cost sweep over clean prefixes', () => {
    const sweep = buildPromptSweep(brief({ intent: 'lean' }), 'current', ['alpha']);

    expect(sweep!.objective).toBe('cost');
    expect(sweep!.prefixes).toBe('clean');
    expect(sweep!.control).toBe('prompt=current');
    expect(sweep!.samples).toBe(5);
  });

  it('produces nothing when no candidate survived', () => {
    expect(buildPromptSweep(brief(), 'current', [])).toBeUndefined();
  });

  it('derives an id that names the node and the knob', () => {
    expect(buildPromptSweep(brief(), 'current', ['alpha'])!.id).toBe('sweep:wf:boss:prompt');
  });
});
