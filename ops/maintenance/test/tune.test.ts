/**
 * Tests for the tune workflow's pure parts (src/tune.ts).
 */

import { describe, it, expect } from 'vitest';
import { parseTuneProposal, parseTuneTicket, renderTuneTicket, resolveSourcePath, tuneKey, variantWins, type ArmResult } from '../src/tune/index.js';

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

const TICKET_BODY = renderTuneTicket({
  target: 'docs-maintenance',
  hypothesis: 'the writer omits a required section',
  trials: 3,
  trialDetail: 'variant wins',
  trialTable: '| arm | gate |\n| --- | --- |\n| variant | 3 |',
  file: 'ops/maintenance/src/docs-workflow.ts',
  find: 'Write the section.',
  replace: 'Write the section, and never omit the summary.',
  costOnly: false,
  marker: '<!-- cycgraph:finding=tune:docs-maintenance:abc123def456 -->',
});

describe('parseTuneTicket', () => {
  it('round-trips the file and both fenced blocks through the ticket renderer', () => {
    expect(parseTuneTicket(TICKET_BODY)).toEqual({
      file: 'ops/maintenance/src/docs-workflow.ts',
      find: 'Write the section.',
      replace: 'Write the section, and never omit the summary.',
    });
  });

  it('returns undefined for a ticket body with no edit block', () => {
    expect(parseTuneTicket('## Summary\n\nA feature request with no edit.')).toBeUndefined();
  });
});

describe('renderTuneTicket cost-win flag', () => {
  const base = {
    target: 'docs-maintenance', hypothesis: 'h', trials: 3, trialDetail: 'd', trialTable: 't',
    file: 'ops/maintenance/src/docs-workflow.ts', find: 'a', replace: 'b',
    marker: '<!-- cycgraph:finding=tune:docs-maintenance:abc123def456 -->',
  };

  it('renders the verify-before-merging caveat only when costOnly is set', () => {
    expect(renderTuneTicket({ ...base, costOnly: true })).toContain('Cost win — verify before merging');
    expect(renderTuneTicket({ ...base, costOnly: false })).not.toContain('Cost win');
  });
});

describe('resolveSourcePath', () => {
  const root = '/repo';
  const sourceDir = 'ops/maintenance/src';

  it('resolves a file inside the source directory', () => {
    expect(resolveSourcePath(root, sourceDir, 'ops/maintenance/src/tune.ts')).toBe('/repo/ops/maintenance/src/tune.ts');
  });

  it('rejects a traversal that escapes through the source directory prefix', () => {
    expect(resolveSourcePath(root, sourceDir, 'ops/maintenance/src/../../../package.json')).toBeUndefined();
    expect(resolveSourcePath(root, sourceDir, 'ops/maintenance/src/../../../.github/workflows/ci.yml')).toBeUndefined();
  });

  it('rejects an absolute path and a sibling directory sharing the prefix', () => {
    expect(resolveSourcePath(root, sourceDir, '/etc/passwd')).toBeUndefined();
    expect(resolveSourcePath(root, sourceDir, 'ops/maintenance/srcx/tune.ts')).toBeUndefined();
  });

  it('rejects the source directory itself', () => {
    expect(resolveSourcePath(root, sourceDir, 'ops/maintenance/src')).toBeUndefined();
  });
});

describe('variantWins', () => {
  const arm = (overrides: Partial<ArmResult> = {}): ArmResult =>
    ({ runs: 3, completed: 3, gatePassed: 2, avgTokens: 10_000, costUsd: 10, ...overrides });

  it('wins on strictly more gate passes', () => {
    expect(variantWins(arm(), arm({ gatePassed: 3 })).wins).toBe(true);
  });

  it('loses when completions regress even with level gates', () => {
    expect(variantWins(arm(), arm({ completed: 2 })).wins).toBe(false);
  });

  it('never wins on tokens alone', () => {
    expect(variantWins(arm(), arm({ avgTokens: 1 })).wins).toBe(false);
  });

  it('files a cost win when materially cheaper at equal gates and completions', () => {
    const verdict = variantWins(arm(), arm({ costUsd: 5 }));

    expect(verdict.wins).toBe(true);
    expect(verdict.costOnly).toBe(true);
    expect(verdict.detail).toContain('cheaper');
  });

  it('does not call a small cost drop a win', () => {
    expect(variantWins(arm(), arm({ costUsd: 9 })).wins).toBe(false);
  });

  it('does not flag a genuine gate win as cost-only', () => {
    expect(variantWins(arm(), arm({ gatePassed: 3, costUsd: 1 })).costOnly).toBeUndefined();
  });

  it('never rescues a gate regression with a cheaper cost', () => {
    expect(variantWins(arm({ gatePassed: 3 }), arm({ gatePassed: 2, costUsd: 1 })).wins).toBe(false);
  });

  it('does not read a crashed variant (zero completions, zero cost) as a cost win', () => {
    const control = arm({ completed: 0, gatePassed: 0 });
    const crashed = arm({ completed: 0, gatePassed: 0, costUsd: 0 });

    expect(variantWins(control, crashed).wins).toBe(false);
  });

  it('grants a cost win when the cheaper variant produced no less output', () => {
    const verdict = variantWins(arm({ yield: 12 }), arm({ costUsd: 5, yield: 12 }));

    expect(verdict.wins).toBe(true);
    expect(verdict.costOnly).toBe(true);
    expect(verdict.detail).toContain('output');
  });

  it('refuses a cost win when the cheaper variant produced less', () => {
    const verdict = variantWins(arm({ yield: 12 }), arm({ costUsd: 5, yield: 6 }));

    expect(verdict.wins).toBe(false);
    expect(verdict.detail).toContain('produced less');
  });

  it('falls back to the caveat-only cost win when no yield is reported', () => {
    const verdict = variantWins(arm(), arm({ costUsd: 5 }));

    expect(verdict.wins).toBe(true);
    expect(verdict.detail).toContain('cannot vouch');
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
