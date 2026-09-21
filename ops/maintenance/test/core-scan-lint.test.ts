/**
 * Tests for the eslint sense class of the core upkeep scanner.
 *
 * Only `npx` is intercepted; every other command — git, for the grep
 * sense classes — runs for real.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EslintOutcome = { stdout: string } | { throws: unknown };

type Run = (
  command: string,
  args: readonly string[],
  options?: unknown,
) => Promise<{ stdout: string; stderr: string }>;

let outcome: EslintOutcome = { stdout: '[]' };
let eslintCalls: string[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const runReal = promisify(actual.execFile) as unknown as Run;
  const execFile = (): never => {
    throw new Error('the callback form of execFile is unused');
  };
  return {
    ...actual,
    // The scanner promisifies execFile, so the stub is the promisified
    // form node itself installs under this symbol, not a callback.
    execFile: Object.assign(execFile, {
      [promisify.custom]: async (
        command: string,
        args: readonly string[],
        options?: unknown,
      ): Promise<{ stdout: string; stderr: string }> => {
        if (command !== 'npx') return runReal(command, args, options);
        eslintCalls.push([command, ...args]);
        if ('throws' in outcome) throw outcome.throws;
        return { stdout: outcome.stdout, stderr: '' };
      },
    }),
  };
});

const { lintFindings, scanCore } = await import('../src/core/scan.js');
const { execFile: realExecFile } = await vi.importActual<typeof import('node:child_process')>(
  'node:child_process',
);
const run = promisify(realExecFile) as unknown as Run;

const report = (results: { filePath: string; messages: unknown[] }[]): string => JSON.stringify(results);

beforeEach(() => {
  outcome = { stdout: '[]' };
  eslintCalls = [];
});

describe('lintFindings', () => {
  it('runs eslint over packages with the json formatter', async () => {
    await lintFindings('/repo');

    expect(eslintCalls).toEqual([['npx', 'eslint', 'packages', '--format', 'json']]);
  });

  it('maps a reported message to a root-relative finding', async () => {
    outcome = {
      stdout: report([
        {
          filePath: '/repo/packages/x/src/a.ts',
          messages: [
            { ruleId: 'no-unused-vars', severity: 1, line: 12, message: "'x' is never used." },
          ],
        },
      ]),
    };

    const findings = await lintFindings('/repo');

    expect(findings).toEqual([
      {
        kind: 'lint-warning',
        file: 'packages/x/src/a.ts',
        line: 12,
        detail: "no-unused-vars: 'x' is never used.",
        key: 'lint-warning:packages/x/src/a.ts:no-unused-vars-x-is-never-used',
        legacyKey: 'lint-warning:packages/x/src/a.ts:no-unused-vars-x-is-never-used',
      },
    ]);
  });

  it('keys a message carrying no rule id under parse', async () => {
    outcome = {
      stdout: report([
        {
          filePath: '/repo/packages/x/src/b.ts',
          messages: [{ ruleId: null, severity: 2, line: 3, message: 'Unexpected token' }],
        },
      ]),
    };

    const findings = await lintFindings('/repo');

    expect(findings).toEqual([
      {
        kind: 'lint-warning',
        file: 'packages/x/src/b.ts',
        line: 3,
        detail: 'parse: Unexpected token',
        key: 'lint-warning:packages/x/src/b.ts:parse-unexpected-token',
        legacyKey: 'lint-warning:packages/x/src/b.ts:parse-unexpected-token',
      },
    ]);
  });

  it('keeps a path reported outside the scan root as eslint wrote it', async () => {
    outcome = {
      stdout: report([
        {
          filePath: '/elsewhere/packages/x/src/c.ts',
          messages: [{ ruleId: 'eqeqeq', severity: 2, line: 8, message: 'Use ===' }],
        },
      ]),
    };

    const findings = await lintFindings('/repo');

    expect(findings[0]!.file).toBe('/elsewhere/packages/x/src/c.ts');
  });

  it('gives every message of a file its own finding', async () => {
    outcome = {
      stdout: report([
        {
          filePath: '/repo/packages/x/src/d.ts',
          messages: [
            { ruleId: 'eqeqeq', severity: 2, line: 4, message: 'Use ===' },
            { ruleId: 'no-shadow', severity: 1, line: 9, message: 'Shadowed name' },
          ],
        },
      ]),
    };

    const findings = await lintFindings('/repo');

    expect(findings.map((finding) => finding.line)).toEqual([4, 9]);
  });

  it('returns nothing for a report whose files are all clean', async () => {
    outcome = { stdout: report([{ filePath: '/repo/packages/x/src/a.ts', messages: [] }]) };

    const findings = await lintFindings('/repo');

    expect(findings).toEqual([]);
  });

  it('returns nothing for an empty report', async () => {
    outcome = { stdout: '[]' };

    const findings = await lintFindings('/repo');

    expect(findings).toEqual([]);
  });

  it('reads the report eslint wrote while exiting non-zero', async () => {
    outcome = {
      throws: Object.assign(new Error('Command failed: npx eslint'), {
        code: 1,
        stdout: report([
          {
            filePath: '/repo/packages/x/src/a.ts',
            messages: [{ ruleId: 'eqeqeq', severity: 2, line: 2, message: 'Use ===' }],
          },
        ]),
      }),
    };

    const findings = await lintFindings('/repo');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toBe('eqeqeq: Use ===');
  });

  it('reads a report written with leading whitespace', async () => {
    outcome = {
      throws: Object.assign(new Error('Command failed: npx eslint'), {
        code: 1,
        stdout: `\n  ${report([
          {
            filePath: '/repo/packages/x/src/a.ts',
            messages: [{ ruleId: 'eqeqeq', severity: 2, line: 2, message: 'Use ===' }],
          },
        ])}\n`,
      }),
    };

    const findings = await lintFindings('/repo');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
  });

  it('rejects with eslint own failure when stdout carries no report', async () => {
    outcome = {
      throws: Object.assign(new Error('Command failed: npx eslint'), {
        code: 2,
        stdout: 'Oops! Something went wrong: invalid config\n',
      }),
    };

    await expect(lintFindings('/repo')).rejects.toThrow('Command failed: npx eslint');
  });

  it('rejects when the failure is not an error object', async () => {
    outcome = { throws: { code: 127 } };

    await expect(lintFindings('/repo')).rejects.toThrow('eslint did not produce a report');
  });
});

describe('scanCore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'core-scan-lint-test-'));
    await mkdir(join(root, 'packages', 'x', 'src'), { recursive: true });
    await writeFile(join(root, 'packages', 'x', 'src', 'thing.ts'), 'export const a = 1;\n');
    await run('git', ['init', '--quiet', root]);
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [
      '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed',
    ], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('senses lint warnings when lint is not disabled', async () => {
    outcome = {
      stdout: report([
        {
          filePath: join(root, 'packages', 'x', 'src', 'thing.ts'),
          messages: [{ ruleId: 'eqeqeq', severity: 2, line: 1, message: 'Use ===' }],
        },
      ]),
    };

    const findings = await scanCore(root);

    expect(findings).toEqual([
      {
        kind: 'lint-warning',
        file: 'packages/x/src/thing.ts',
        line: 1,
        detail: 'eqeqeq: Use ===',
        key: 'lint-warning:packages/x/src/thing.ts:eqeqeq-use',
        legacyKey: 'lint-warning:packages/x/src/thing.ts:eqeqeq-use',
      },
    ]);
  });

  it('does not run eslint when lint is disabled', async () => {
    await scanCore(root, { lint: false });

    expect(eslintCalls).toEqual([]);
  });
});
