/**
 * Tests for scan scoping (scopeFindings in src/docs-scan.ts) — the
 * roots/exclude split, diff mode, and the open-PR DEFER rule.
 */

import { describe, it, expect } from 'vitest';
import { scopeFindings, type DocsFinding } from '../src/docs-scan.js';

function finding(overrides: Partial<DocsFinding>): DocsFinding {
  return {
    kind: 'missing-path',
    file: 'README.md',
    line: 1,
    target: 'src/gone.ts',
    detail: 'stale',
    candidates: [],
    ...overrides,
  };
}

const IN_WEBSITE = finding({ file: 'apps/docs/src/page.md' });
const IN_REPO = finding({ file: 'CONTRIBUTING.md' });

describe('scopeFindings', () => {
  it('keeps only findings under the given roots', () => {
    const scoped = scopeFindings([IN_WEBSITE, IN_REPO], { roots: ['apps/docs'] });

    expect(scoped).toEqual([IN_WEBSITE]);
  });

  it('drops findings under excluded paths', () => {
    const scoped = scopeFindings([IN_WEBSITE, IN_REPO], { exclude: ['apps/docs'] });

    expect(scoped).toEqual([IN_REPO]);
  });

  it('an empty roots list keeps everything', () => {
    expect(scopeFindings([IN_WEBSITE, IN_REPO], { roots: [] })).toHaveLength(2);
  });

  it('defers findings in files an open maintenance PR touches', () => {
    const scoped = scopeFindings([IN_WEBSITE, IN_REPO], { deferredFiles: ['CONTRIBUTING.md'] });

    expect(scoped).toEqual([IN_WEBSITE]);
  });

  it('diff mode keeps a finding whose document changed', () => {
    const scoped = scopeFindings([IN_REPO], { changedPaths: ['CONTRIBUTING.md'] });

    expect(scoped).toEqual([IN_REPO]);
  });

  it('diff mode keeps a finding whose target path changed', () => {
    const moved = finding({ target: 'src/moved.ts' });

    const scoped = scopeFindings([moved], { changedPaths: ['packages/x/src/moved.ts'] });

    expect(scoped).toEqual([moved]);
  });

  it('diff mode keeps a script finding when a package manifest changed', () => {
    const script = finding({ kind: 'unknown-script', target: 'db:migrate' });

    const scoped = scopeFindings([script], { changedPaths: ['packages/x/package.json'] });

    expect(scoped).toEqual([script]);
  });

  it('diff mode drops findings no change plausibly staled', () => {
    const script = finding({ kind: 'unknown-script', target: 'db:migrate' });

    const scoped = scopeFindings([IN_REPO, script], { changedPaths: ['packages/x/src/other.ts'] });

    expect(scoped).toEqual([]);
  });
});
