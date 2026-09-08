/**
 * Tests for the core upkeep scanner (src/core-scan.ts) — the grep
 * sense classes, key stability, and ledger dedupe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scanCore, unfiledFindings, type CoreFinding } from '../src/core-scan.js';

const exec = promisify(execFile);

let root: string;

async function seedRepo(): Promise<void> {
  await mkdir(join(root, 'packages', 'x', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'x', 'test'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'x', 'src', 'thing.ts'),
    'export const a = 1;\n// TODO: replace this with the real algorithm\n',
  );
  await writeFile(
    join(root, 'packages', 'x', 'test', 'thing.test.ts'),
    "it.skip('covers the slow path', () => {});\n",
  );
  await exec('git', ['init', '--quiet', root]);
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed',
  ], { cwd: root });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'core-scan-test-'));
  await seedRepo();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanCore', () => {
  it('finds TODO comments and skipped tests in tracked sources', async () => {
    const findings = await scanCore(root, { lint: false });

    expect(findings.map((f) => f.kind).sort()).toEqual(['skipped-test', 'todo']);
    const todo = findings.find((f) => f.kind === 'todo')!;
    expect(todo.file).toBe('packages/x/src/thing.ts');
    expect(todo.line).toBe(2);
  });

  it('keys are stable when a finding moves to another line', async () => {
    const before = await scanCore(root, { lint: false });
    await writeFile(
      join(root, 'packages', 'x', 'src', 'thing.ts'),
      'export const b = 2;\nexport const a = 1;\n// TODO: replace this with the real algorithm\n',
    );
    await exec('git', ['add', '-A'], { cwd: root });

    const after = await scanCore(root, { lint: false });

    const key = (findings: CoreFinding[]) => findings.find((f) => f.kind === 'todo')!.key;
    expect(key(after)).toBe(key(before));
  });

  it('does not sense a skip spelled inside a fixture string', async () => {
    await writeFile(
      join(root, 'packages', 'x', 'test', 'fixture.test.ts'),
      `const text = "it('a', f); it.skip('b', f); test('c', f)";\n`,
    );
    await exec('git', ['add', '-A'], { cwd: root });

    const findings = await scanCore(root, { lint: false });

    expect(findings.filter((f) => f.file.includes('fixture'))).toHaveLength(0);
  });

  it('does not sense prose that mentions TODO without owing one', async () => {
    await writeFile(
      join(root, 'packages', 'x', 'src', 'prose.ts'),
      "// a TODO comment is there or it is not\nconst prompt = 'resolve a TODO: like this one';\n",
    );
    await exec('git', ['add', '-A'], { cwd: root });

    const findings = await scanCore(root, { lint: false });

    expect(findings.filter((f) => f.file.includes('prose'))).toHaveLength(0);
  });

  it('ignores untracked files', async () => {
    await writeFile(join(root, 'packages', 'x', 'src', 'scratch.ts'), '// TODO: untracked\n');

    const findings = await scanCore(root, { lint: false });

    expect(findings.filter((f) => f.file.includes('scratch'))).toHaveLength(0);
  });
});

describe('unfiledFindings', () => {
  it('drops findings whose key the ledger already carries', async () => {
    const findings = await scanCore(root, { lint: false });
    const marked = new Set([findings[0]!.key]);

    const fresh = unfiledFindings(findings, marked);

    expect(fresh).toHaveLength(findings.length - 1);
    expect(fresh.some((f) => f.key === findings[0]!.key)).toBe(false);
  });
});
