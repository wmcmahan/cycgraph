/**
 * Tests for the repository helpers (src/repo.ts) — the repository map
 * every proposer/auditor prompt is oriented by, the mention strip that
 * keeps relayed prose from dispatching workflows, and the credential
 * scrub every workflow spawn site relies on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { RUNTIME_CONFIG_ENV_VARS } from '@cycgraph/orchestrator/internal';
import { NEEDS_HUMAN_LABEL, WORKFLOW_MENTION, checksEnv, flagNeedsHuman, repoMap, stripMentions } from '../src/repo.js';

const exec = promisify(execFile);

const roots: string[] = [];

async function seedRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cycgraph-repo-map-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  await exec('git', ['init', '--quiet', root]);
  await exec('git', ['add', '-A'], { cwd: root });
  return root;
}

const docNames = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `doc-${String(index + 1).padStart(4, '0')}.md`);

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repoMap', () => {
  it('counts source files per package and buckets their subdirectories', async () => {
    const root = await seedRepo({
      'README.md': '# repo\n',
      'docs/guide.md': '# guide\n',
      'packages/alpha/package.json': JSON.stringify({ name: '@cycgraph/alpha', description: 'Graph core' }),
      'packages/alpha/README.md': '# alpha\n',
      'packages/alpha/docs/design.md': '# design\n',
      'packages/alpha/src/index.ts': 'export const a = 1;\n',
      'packages/alpha/src/core/run.ts': 'export const b = 2;\n',
      'packages/alpha/src/core/step.tsx': 'export const c = 3;\n',
      'packages/alpha/src/util/x.ts': 'export const d = 4;\n',
    });

    const map = await repoMap(root);

    expect(map).toBe([
      'Repository map (tracked files). Root docs: README.md',
      'packages/alpha — Graph core',
      '  src (4 ts files): core util',
      '  docs: README.md',
    ].join('\n'));
  });

  it('ignores sources more than one directory below src', async () => {
    const root = await seedRepo({
      'README.md': '# repo\n',
      'packages/alpha/package.json': JSON.stringify({ description: 'Graph core' }),
      'packages/alpha/src/index.ts': 'export const a = 1;\n',
      'packages/alpha/src/deep/nested/far.ts': 'export const b = 2;\n',
    });

    const map = await repoMap(root);

    expect(map).toBe([
      'Repository map (tracked files). Root docs: README.md',
      'packages/alpha — Graph core',
      '  src (1 ts files): (flat)',
    ].join('\n'));
  });

  it('lists only top-level markdown as root docs', async () => {
    const root = await seedRepo({
      'README.md': '# repo\n',
      'CHANGELOG.md': '# changes\n',
      'docs/guide.md': '# guide\n',
      'packages/alpha/notes.md': '# notes\n',
    });

    const map = await repoMap(root);

    expect(map).toBe([
      'Repository map (tracked files). Root docs: CHANGELOG.md, README.md',
      'packages/alpha —',
      '  docs: notes.md',
    ].join('\n'));
  });

  it('lists a workspace layout when its package.json is missing', async () => {
    const root = await seedRepo({
      'README.md': '# repo\n',
      'ops/beta/src/main.ts': 'export const a = 1;\n',
    });

    const map = await repoMap(root);

    expect(map).toBe([
      'Repository map (tracked files). Root docs: README.md',
      'ops/beta —',
      '  src (1 ts files): (flat)',
    ].join('\n'));
  });

  it('lists a workspace layout when its package.json is unparseable', async () => {
    const root = await seedRepo({
      'README.md': '# repo\n',
      'apps/web/package.json': '{ "description": ',
      'apps/web/src/app.tsx': 'export const a = 1;\n',
    });

    const map = await repoMap(root);

    expect(map).toBe([
      'Repository map (tracked files). Root docs: README.md',
      'apps/web —',
      '  src (1 ts files): (flat)',
    ].join('\n'));
  });

  it('returns the whole map when it stays under the size limit', async () => {
    const names = docNames(300);
    const root = await seedRepo(Object.fromEntries(names.map((name) => [name, ''])));

    const map = await repoMap(root);

    expect(map).toBe(`Repository map (tracked files). Root docs: ${names.join(', ')}`);
  });

  it('truncates mid-line at the size limit and marks the cut', async () => {
    const names = docNames(700);
    const root = await seedRepo(Object.fromEntries(names.map((name) => [name, ''])));

    const map = await repoMap(root);

    const whole = `Repository map (tracked files). Root docs: ${names.join(', ')}`;
    expect(map).toBe(`${whole.slice(0, 8_000)}\n… (truncated)`);
  });
});

describe('stripMentions', () => {
  it('neutralizes the workflow-dispatching mention', () => {
    const stripped = stripMentions(`${WORKFLOW_MENTION} please review`);

    expect(stripped).toBe('cycgraph please review');
  });

  it('neutralizes the mention in mixed case', () => {
    const stripped = stripMentions('@CycGraph please run');

    expect(stripped).toBe('cycgraph please run');
  });

  it('neutralizes every occurrence', () => {
    const stripped = stripMentions('@cycgraph and @cycgraph again');

    expect(stripped).toBe('cycgraph and cycgraph again');
  });

  it('preserves punctuation trailing the mention', () => {
    const stripped = stripMentions('@cycgraph, address the findings.');

    expect(stripped).toBe('cycgraph, address the findings.');
  });

  it('neutralizes a mention embedded mid-sentence', () => {
    const stripped = stripMentions('the reviewer asked @cycgraph to revise');

    expect(stripped).toBe('the reviewer asked cycgraph to revise');
  });

  it('returns text without the mention unchanged', () => {
    const stripped = stripMentions('the tests are exact and comment-free');

    expect(stripped).toBe('the tests are exact and comment-free');
  });

  it('returns the empty string unchanged', () => {
    const stripped = stripMentions('');

    expect(stripped).toBe('');
  });
});

describe('checksEnv', () => {
  it('drops every database credential from the spawned environment', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pw@prod.example.com:5432/app');
    vi.stubEnv('APP_DATABASE_URL', 'postgres://app:pw@prod.example.com:5432/app');
    vi.stubEnv('PLATFORM_DATABASE_URL', 'postgres://admin:pw@prod.example.com:5432/app');
    vi.stubEnv('SUPABASE_DB_URL', 'postgres://user:pw@db.supabase.co:5432/postgres');

    const env = checksEnv();

    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['APP_DATABASE_URL']).toBeUndefined();
    expect(env['PLATFORM_DATABASE_URL']).toBeUndefined();
    expect(env['SUPABASE_DB_URL']).toBeUndefined();
  });

  it('preserves unrelated variables', () => {
    vi.stubEnv('PATH', '/usr/bin');

    const env = checksEnv();

    expect(env['PATH']).toBe('/usr/bin');
  });

  it('drops the log level so spawned suites keep the logger default', () => {
    vi.stubEnv('LOG_LEVEL', 'info');

    const env = checksEnv();

    expect(env['LOG_LEVEL']).toBeUndefined();
  });

  it('drops every engine tuning knob so spawned suites test a default engine', () => {
    for (const name of RUNTIME_CONFIG_ENV_VARS) vi.stubEnv(name, '204800');

    const env = checksEnv();

    for (const name of RUNTIME_CONFIG_ENV_VARS) expect(env[name]).toBeUndefined();
  });

  it('leaves process.env untouched', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/app');

    checksEnv();

    expect(process.env['DATABASE_URL']).toBe('postgres://localhost:5432/app');
  });
});

describe('flagNeedsHuman', () => {
  function fakeOps(labelOk: boolean) {
    const calls: { label: string[]; comment: string[] } = { label: [], comment: [] };
    const ops = {
      addLabel: async (_root: string, _issue: number, label: string) => {
        calls.label.push(label);
        return labelOk ? { ok: true, detail: `labeled ${label}` } : { ok: false, detail: 'label denied' };
      },
      comment: async (_root: string, _issue: number, body: string) => {
        calls.comment.push(body);
        return { ok: true, detail: 'commented' };
      },
    };
    return { ops, calls };
  }

  it('labels first and comments with the given body when the label sticks', async () => {
    const { ops, calls } = fakeOps(true);

    const result = await flagNeedsHuman('/repo', 7, 'the retry budget is spent', { ops });

    expect(result).toEqual({ flagged: true, detail: 'commented' });
    expect(calls.label).toEqual([NEEDS_HUMAN_LABEL]);
    expect(calls.comment).toEqual(['the retry budget is spent']);
  });

  it('does not comment when the label fails', async () => {
    const { ops, calls } = fakeOps(false);

    const result = await flagNeedsHuman('/repo', 7, 'the retry budget is spent', { ops });

    expect(result).toEqual({ flagged: false, detail: 'label failed: label denied' });
    expect(calls.comment).toEqual([]);
  });
});
