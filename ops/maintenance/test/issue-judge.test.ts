/**
 * Tests for the issue-fix verdict (src/issue-judge.ts) — marker
 * parsing and the per-class anti-gaming guards.
 */

import { describe, it, expect } from 'vitest';
import { findingMarker } from '@cycgraph/tools/git';
import {
  commentOnlyChange,
  eslintDisableCount,
  judgeIssueFix,
  parseIssueFinding,
  testCount,
  type IssueFixEvidence,
} from '../src/issue-judge.js';

describe('parseIssueFinding', () => {
  it('recovers kind, file, and key from a filed issue body', () => {
    const body = `detail line\n\nLocation: \`packages/x/src/a.ts:2\`\n\n${findingMarker('todo:packages/x/src/a.ts:fix-me')}`;

    expect(parseIssueFinding(body)).toEqual({
      key: 'todo:packages/x/src/a.ts:fix-me',
      kind: 'todo',
      file: 'packages/x/src/a.ts',
    });
  });

  it('returns undefined for a body without a marker or with an unknown kind', () => {
    expect(parseIssueFinding('no marker')).toBeUndefined();
    expect(parseIssueFinding(findingMarker('mystery:a.ts:x'))).toBeUndefined();
  });
});

describe('commentOnlyChange', () => {
  it('is true when every changed line is a comment or blank', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n-// TODO: do the thing\n- \n';

    expect(commentOnlyChange(diff)).toBe(true);
  });

  it('is false when a code line changed', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n-// TODO: do the thing\n+const done = true;\n';

    expect(commentOnlyChange(diff)).toBe(false);
  });
});

describe('testCount', () => {
  it('counts test callsites whether skipped or not', () => {
    const text = "it('a', f); it.skip('b', f); test('c', f); fit('d', f); limit(x);";

    expect(testCount(text)).toBe(3);
  });
});

describe('eslintDisableCount', () => {
  it('counts disable markers', () => {
    expect(eslintDisableCount('// eslint-disable-next-line x\n/* eslint-disable y */')).toBe(2);
  });
});

describe('judgeIssueFix', () => {
  const FINDING = { key: 'todo:a.ts:do-it', kind: 'todo' as const, file: 'a.ts' };

  function evidence(overrides: Partial<IssueFixEvidence>): IssueFixEvidence {
    return {
      finding: FINDING,
      beforeKeys: [FINDING.key],
      afterKeys: [],
      text: { before: '', after: '' },
      diff: '-// TODO: do it\n+real();\n',
      ...overrides,
    };
  }

  it('passes a todo resolved with real code changes', () => {
    const verdict = judgeIssueFix(evidence({}));

    expect(verdict).toEqual({
      resolved: true, introduced_count: 0, weakened: false, detail: 'resolved todo in a.ts',
    });
  });

  it('refuses a todo resolved by deleting only the comment', () => {
    const verdict = judgeIssueFix(evidence({ diff: '-// TODO: do it\n' }));

    expect(verdict.weakened).toBe(true);
  });

  it('refuses an un-skip that deleted the test', () => {
    const verdict = judgeIssueFix(evidence({
      finding: { key: 'skipped-test:t.ts:x', kind: 'skipped-test', file: 't.ts' },
      beforeKeys: ['skipped-test:t.ts:x'],
      text: { before: "it.skip('x', f); it('y', f);", after: "it('y', f);" },
    }));

    expect(verdict.weakened).toBe(true);
  });

  it('refuses a lint warning silenced with eslint-disable', () => {
    const verdict = judgeIssueFix(evidence({
      finding: { key: 'lint-warning:l.ts:rule', kind: 'lint-warning', file: 'l.ts' },
      beforeKeys: ['lint-warning:l.ts:rule'],
      text: { before: 'bad();', after: '// eslint-disable-next-line rule\nbad();' },
    }));

    expect(verdict.weakened).toBe(true);
  });

  it('counts newly introduced findings', () => {
    const verdict = judgeIssueFix(evidence({ afterKeys: ['todo:b.ts:new-one'] }));

    expect(verdict.resolved).toBe(true);
    expect(verdict.introduced_count).toBe(1);
  });

  it('reports an unresolved finding', () => {
    const verdict = judgeIssueFix(evidence({ afterKeys: [FINDING.key] }));

    expect(verdict.resolved).toBe(false);
  });
});
