/**
 * Tests for the tune workflow's pure parts (src/tune.ts).
 */

import { describe, it, expect } from 'vitest';
import { parseTuneProposal, tuneKey, variantWins, type ArmResult } from '../src/tune.js';

const REPLY = [
  'HYPOTHESIS: auditors drop findings because the evidence format is underspecified.',
  'FILE: ops/maintenance/src/audit-workflow.ts',
  'FIND:',
  '<<<',
  'name the exact code path',
  '>>>',
  'REPLACE:',
  '<<<',
  'name the exact code path with file and line',
  '>>>',
].join('\n');

describe('parseTuneProposal', () => {
  it('recovers hypothesis, file, and fenced texts from a well-formed reply', () => {
    const { proposal, missing } = parseTuneProposal(REPLY);

    expect(missing).toEqual([]);
    expect(proposal).toEqual({
      hypothesis: 'auditors drop findings because the evidence format is underspecified.',
      file: 'ops/maintenance/src/audit-workflow.ts',
      find: 'name the exact code path',
      replace: 'name the exact code path with file and line',
    });
  });

  it('names each missing block', () => {
    const { proposal, missing } = parseTuneProposal('HYPOTHESIS: something');

    expect(proposal).toBeUndefined();
    expect(missing).toEqual(['FILE', 'FIND', 'REPLACE']);
  });

  it('rejects a replace identical to find', () => {
    const identical = REPLY.replace('name the exact code path with file and line', 'name the exact code path');

    expect(parseTuneProposal(identical).missing).toEqual(['a REPLACE that differs from FIND']);
  });
});

describe('variantWins', () => {
  const arm = (overrides: Partial<ArmResult> = {}): ArmResult =>
    ({ runs: 3, completed: 3, gatePassed: 2, avgTokens: 10_000, ...overrides });

  it('wins on strictly more gate passes', () => {
    expect(variantWins(arm(), arm({ gatePassed: 3 })).wins).toBe(true);
  });

  it('loses when completions regress even with level gates', () => {
    expect(variantWins(arm(), arm({ completed: 2 })).wins).toBe(false);
  });

  it('never wins on tokens alone', () => {
    expect(variantWins(arm(), arm({ avgTokens: 1 })).wins).toBe(false);
  });
});

describe('tuneKey', () => {
  it('is stable for the same edit and distinct for different ones', () => {
    const edit = { file: 'a.ts', replace: 'x' };

    expect(tuneKey('docs-maintenance', edit)).toBe(tuneKey('docs-maintenance', edit));
    expect(tuneKey('docs-maintenance', edit)).not.toBe(tuneKey('docs-maintenance', { file: 'a.ts', replace: 'y' }));
    expect(tuneKey('docs-maintenance', edit)).toMatch(/^tune:docs-maintenance:[0-9a-f]{12}$/);
  });
});
