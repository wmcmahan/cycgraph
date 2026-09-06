/**
 * Tests for the documentation scanner (src/docs-scan.ts) —
 * the fitness function a docs-maintenance run is judged by.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findingKey, judgeFix, scanDocs, type DocsFinding } from '../src/docs-scan.js';

let root: string;

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-docscan-'));
  await write('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanDocs', () => {
  it('reports a relative link whose target does not exist', async () => {
    await write('docs/guide.md', 'See [the state](../types/state.ts) for details.\n');

    const [finding] = await scanDocs(root);

    expect(finding).toMatchObject({ kind: 'broken-link', file: 'docs/guide.md', line: 1, target: '../types/state.ts' });
  });

  it('accepts a relative link that resolves', async () => {
    await write('docs/guide.md', 'See [the other](./other.md).\n');
    await write('docs/other.md', '# Other\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('reports a repository path the repository does not have', async () => {
    await write('README.md', 'The runner lives in packages/orchestrator/src/runner/graph-runner.ts today.\n');

    const [finding] = await scanDocs(root);

    expect(finding).toMatchObject({ kind: 'missing-path', target: 'packages/orchestrator/src/runner/graph-runner.ts' });
  });

  it('accepts a repository path that exists', async () => {
    await write('packages/thing/src/index.ts', 'export {};\n');
    await write('README.md', 'It lives in packages/thing/src/index.ts.\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('accepts a path written relative to the document\u2019s own package', async () => {
    await write('packages/thing/package.json', '{"name":"thing"}');
    await write('packages/thing/examples/demo/demo.ts', 'export {};\n');
    await write('packages/thing/examples/README.md', 'Run examples/demo/demo.ts to see it.\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('reports a command no package defines', async () => {
    await write('README.md', 'Run `npm run deploy` to ship.\n');

    const [finding] = await scanDocs(root);

    expect(finding).toMatchObject({ kind: 'unknown-script', target: 'deploy' });
  });

  it('reports a root instruction naming a script only a package defines', async () => {
    await write('packages/thing/package.json', JSON.stringify({ name: 'thing', scripts: { 'db:migrate': 'tsx x.ts' } }));
    await write('CONTRIBUTING.md', '```bash\nnpm run db:migrate\n```\n');

    const [finding] = await scanDocs(root);

    expect(finding).toMatchObject({ kind: 'unknown-script', file: 'CONTRIBUTING.md', target: 'db:migrate' });
  });

  it('accepts a package document naming its own script', async () => {
    await write('packages/thing/package.json', JSON.stringify({ name: 'thing', scripts: { 'db:migrate': 'tsx x.ts' } }));
    await write('packages/thing/README.md', '```bash\nnpm run db:migrate\n```\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('suggests what a broken reference probably meant', async () => {
    await write('packages/thing/src/state/state.ts', 'export {};\n');
    await write('docs/guide.md', 'See [state](../types/state.ts).\n');

    const [finding] = await scanDocs(root);

    expect(finding!.candidates).toContain('packages/thing/src/state/state.ts');
  });

  it('accepts a fenced command that names its workspace', async () => {
    await write('packages/thing/package.json', JSON.stringify({ name: 'thing', scripts: { evals: 'x' } }));
    await write('docs/guide.md', '```bash\nnpm run evals --workspace=packages/thing -- --fast\n```\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('reports a fenced command that cannot run where it is written', async () => {
    await write('packages/thing/package.json', JSON.stringify({ name: 'thing', scripts: { evals: 'x' } }));
    await write('docs/guide.md', '```bash\nnpm run evals -- --fast\n```\n');

    const [finding] = await scanDocs(root);

    expect(finding).toMatchObject({ kind: 'unknown-script', target: 'evals' });
    expect(finding!.detail).toContain('cannot be run as written');
  });

  it('leaves a prose mention alone when the script exists somewhere', async () => {
    await write('packages/thing/package.json', JSON.stringify({ name: 'thing', scripts: { evals: 'x' } }));
    await write('docs/guide.md', 'The harness entry point is `npm run evals`, with flags.\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('ignores a path the reader is told to delete', async () => {
    await write('docs/guide.md', '```bash\nrm -f packages/thing/generated/baseline.json\n```\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('accepts a command the root manifest defines', async () => {
    await write('README.md', 'Run `npm run build` first.\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('skips build output and dependencies', async () => {
    await write('node_modules/pkg/README.md', 'See [gone](./nowhere.md).\n');
    await write('dist/notes.md', 'See [gone](./nowhere.md).\n');

    expect(await scanDocs(root)).toEqual([]);
  });

  it('orders findings by file so an unattended loop makes progress', async () => {
    await write('a.md', 'See [x](./gone-a.md).\n');
    await write('b.md', 'See [x](./gone-b.md).\n');

    const findings = await scanDocs(root);

    expect(findings.map((f) => f.file)).toEqual(['a.md', 'b.md']);
  });
});

describe('judgeFix', () => {
  const targeted: DocsFinding = {
    kind: 'unknown-script', file: 'a.md', line: 1, target: 'db:migrate', detail: '',
  };
  const other: DocsFinding = {
    kind: 'broken-link', file: 'b.md', line: 2, target: './also-gone.md', detail: '',
  };

  it('calls a fix resolved when the targeted finding is gone', () => {
    const verdict = judgeFix(targeted, [targeted, other], [other]);

    expect(verdict).toMatchObject({ resolved: true, introduced: [], remaining: 1 });
  });

  it('reports the fix as unresolved when the finding survives', () => {
    const verdict = judgeFix(targeted, [targeted], [targeted]);

    expect(verdict.resolved).toBe(false);
    expect(verdict.detail).toContain('still wrong');
  });

  it('calls out a claim that was deleted rather than corrected', () => {
    const verdict = judgeFix(targeted, [targeted], [], {
      before: 'Run `npm run db:migrate` to set up.\n',
      after: '# database setup\n',
    });

    expect(verdict).toMatchObject({ resolved: true, weakened: true });
    expect(verdict.detail).toContain('removed');
  });

  it('accepts a claim that was replaced with a working one', () => {
    const verdict = judgeFix(targeted, [targeted], [], {
      before: 'Run `npm run db:migrate` to set up.\n',
      after: 'Run `npm run migrate --workspace=packages/orchestrator-postgres` to set up.\n',
    });

    expect(verdict).toMatchObject({ resolved: true, weakened: false });
  });

  it('names findings the fix introduced', () => {
    const verdict = judgeFix(targeted, [targeted], [other]);

    expect(verdict.introduced.map(findingKey)).toEqual([findingKey(other)]);
    expect(verdict.detail).toContain('introduced 1 new finding');
  });
});
