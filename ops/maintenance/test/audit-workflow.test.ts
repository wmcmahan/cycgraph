/**
 * Tests for the repo-audit workflow's changed-scope detection
 * (src/audit-workflow.ts) — which commits count as change worth
 * re-prioritizing an audit scope for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { changedScopesSince } from '../src/audit-workflow.js';

const exec = promisify(execFile);

let root: string;

async function commitAs(author: string, path: string, contents: string): Promise<string> {
  await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(root, path), contents);
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', [
    '-c', `user.name=${author}`, '-c', 'user.email=t@t.local',
    'commit', '--quiet', '--author', `${author} <t@t.local>`, '-m', `touch ${path}`,
  ], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 't@t.local' } });
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-changed-test-'));
  await exec('git', ['init', '--quiet', root]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('changedScopesSince', () => {
  it('counts scopes from human commits and ignores the bot identity', async () => {
    const base = await commitAs('human', 'seed.txt', 'seed');
    await commitAs('cycgraph-maintenance', 'packages/a2a/fix.ts', 'bot fix');
    await commitAs('human', 'packages/memory/edit.ts', 'human edit');

    const scopes = await changedScopesSince(root, base, new Set(['cycgraph-maintenance']));

    expect([...scopes]).toEqual(['packages/memory']);
  });

  it('counts every author when no bot identities are given', async () => {
    const base = await commitAs('human', 'seed.txt', 'seed');
    await commitAs('cycgraph-maintenance', 'packages/a2a/fix.ts', 'bot fix');

    const scopes = await changedScopesSince(root, base);

    expect([...scopes]).toEqual(['packages/a2a']);
  });

  it('returns the empty set when there is no recorded head', async () => {
    expect(await changedScopesSince(root, undefined)).toEqual(new Set());
  });
});
