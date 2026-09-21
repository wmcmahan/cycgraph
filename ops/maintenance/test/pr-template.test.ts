/**
 * Tests for the PR-template evidence rules (src/pr-template.ts).
 */

import { describe, expect, it } from 'vitest';
import { closesIn, diffPaths, stripCloses, templateEvidence } from '../src/shared/pr-template.js';

function diffFor(paths: string[], addedByPath: Record<string, string[]> = {}): string {
  return paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' context',
    ...(addedByPath[path] ?? ['added line']).map((line) => `+${line}`),
  ].join('\n')).join('\n') + '\n';
}

const tickFor = (evidence: ReturnType<typeof templateEvidence>, match: string) =>
  evidence.ticks?.find((tick) => tick.match === match);

describe('diffPaths', () => {
  it('collects new-file paths from the diff headers', () => {
    expect(diffPaths(diffFor(['src/a.ts', 'test/b.test.ts']))).toEqual(['src/a.ts', 'test/b.test.ts']);
  });
});

describe('closesIn', () => {
  it('collects issue numbers from Closes markers across details', () => {
    expect(closesIn(['Closes #220. the tree was changed', 'also Closes #7'])).toEqual([220, 7]);
  });

  it('dedupes repeated numbers', () => {
    expect(closesIn(['Closes #5', 'Closes #5'])).toEqual([5]);
  });
});

describe('stripCloses', () => {
  it('removes the marker and keeps the prose', () => {
    expect(stripCloses(['Closes #220. the tree was changed'])).toEqual(['the tree was changed']);
  });

  it('leaves details without a marker untouched', () => {
    expect(stripCloses(['plain detail'])).toEqual(['plain detail']);
  });
});

describe('templateEvidence', () => {
  it('ticks the tests-pass box only when a test-shaped check ran', () => {
    const withTests = templateEvidence(diffFor(['src/a.ts']), { checks: ['npm test'] });
    const lintOnly = templateEvidence(diffFor(['src/a.ts']), { checks: ['npm run lint:eslint'] });

    expect(tickFor(withTests, 'All existing tests pass')?.checked).not.toBe(false);
    expect(tickFor(lintOnly, 'All existing tests pass')?.checked).toBe(false);
  });

  it('ticks new-tests-added when the diff touches test files', () => {
    const evidence = templateEvidence(diffFor(['packages/tools/test/pr.test.ts']));

    expect(tickFor(evidence, 'New tests added')).toBeDefined();
  });

  it('never ticks the manual-testing box', () => {
    const evidence = templateEvidence(diffFor(['src/a.ts']));

    expect(tickFor(evidence, 'Tested manually')?.checked).toBe(false);
  });

  it('ticks the standards box only when a reviewer approved', () => {
    const reviewed = templateEvidence(diffFor(['src/a.ts']), { reviewed: true });
    const unreviewed = templateEvidence(diffFor(['src/a.ts']));

    expect(tickFor(reviewed, 'coding standards')).toBeDefined();
    expect(tickFor(unreviewed, 'coding standards')).toBeUndefined();
  });

  it('marks database and security blocks not applicable when their paths are untouched', () => {
    const evidence = templateEvidence(diffFor(['apps/docs/src/page.md']));

    expect(evidence.notApplicable?.map((section) => section.heading))
      .toEqual(['Database & data integrity', 'Security']);
  });

  it('keeps the database block when the diff touches the postgres package', () => {
    const evidence = templateEvidence(diffFor(['packages/orchestrator-postgres/src/schema.ts']));

    expect(evidence.notApplicable?.some((section) => section.heading === 'Database & data integrity')).toBe(false);
  });

  it('keeps the security block when the diff touches an ssrf path', () => {
    const evidence = templateEvidence(diffFor(['packages/a2a/src/connection.ts', 'packages/tools/src/web/ssrf.ts']));

    expect(evidence.notApplicable?.some((section) => section.heading === 'Security')).toBe(false);
  });

  it('ticks the changeset box when the diff carries one', () => {
    const evidence = templateEvidence(diffFor(['.changeset/wild-pandas-cheer.md', 'packages/tools/src/git/pr.ts']));

    expect(tickFor(evidence, 'Ran `npx changeset`')?.checked).not.toBe(false);
  });

  it('ticks the no-changeset-needed box for a docs-only diff', () => {
    const evidence = templateEvidence(diffFor(['apps/docs/src/page.md', 'ops/maintenance/README.md']));

    expect(tickFor(evidence, 'docs / tests / evals-only')).toBeDefined();
  });

  it('flags a shipped-source diff without a changeset instead of ticking', () => {
    const evidence = templateEvidence(diffFor(['packages/tools/src/git/pr.ts']));

    expect(tickFor(evidence, 'Ran `npx changeset`')?.checked).toBe(false);
  });

  it('withholds the console tick when the diff adds console.error', () => {
    const evidence = templateEvidence(diffFor(['src/a.ts'], { 'src/a.ts': ['console.error("boom")'] }));

    expect(tickFor(evidence, 'console.warn')).toBeUndefined();
  });

  it('withholds the extension tick when an added relative import lacks .js', () => {
    const evidence = templateEvidence(diffFor(['src/a.ts'], { 'src/a.ts': ["import { x } from './y';"] }));

    expect(tickFor(evidence, '`.js` extension')).toBeUndefined();
  });

  it('carries closes from the details', () => {
    const evidence = templateEvidence(diffFor(['src/a.ts']), { details: ['Closes #220. resolved'] });

    expect(evidence.closes).toEqual([220]);
  });
});
