/**
 * What the codebase owes itself, mechanically.
 *
 * The core-upkeep tier senses only what a machine can verify: a TODO
 * or FIXME comment is there or it is not, a test is skipped or it is
 * not, eslint reports a warning or it does not. Each finding carries a
 * stable `key` — deliberately line-free, so a finding keeps its
 * identity while unrelated edits move it — which is what the issue
 * ledger dedupes on.
 *
 * @module maintenance/core-scan
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One mechanically-detected piece of owed upkeep. */
export interface CoreFinding {
  kind: 'todo' | 'skipped-test' | 'lint-warning';
  /** Repository-relative file. */
  file: string;
  line: number;
  /** One line a reader can act on. */
  detail: string;
  /** Stable identity for the issue ledger: kind, file, and normalized text. */
  key: string;
}

function keyFor(kind: CoreFinding['kind'], file: string, text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `${kind}:${file}:${normalized}`;
}

async function gitGrep(root: string, pattern: string, pathspecs: string[]): Promise<{ file: string; line: number; text: string }[]> {
  // git grep exits 1 on no matches, which is an answer rather than a failure.
  const { stdout } = await run(
    'git', ['grep', '-nE', pattern, '--', ...pathspecs],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  ).catch((error: { code?: number; stdout?: string }) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  return stdout.split('\n').filter(Boolean).flatMap((row) => {
    const match = row.match(/^([^:]+):(\d+):(.*)$/);
    return match ? [{ file: match[1]!, line: Number(match[2]), text: match[3]!.trim() }] : [];
  });
}

async function todoFindings(root: string): Promise<CoreFinding[]> {
  const rows = await gitGrep(root, '(TODO|FIXME|HACK)(:|\\(| )', [':(glob)packages/*/src/**/*.ts', ':(glob)ops/*/src/**/*.ts']);
  return rows.map((row) => ({
    kind: 'todo' as const,
    file: row.file,
    line: row.line,
    detail: row.text.slice(0, 200),
    key: keyFor('todo', row.file, row.text),
  }));
}

async function skippedTestFindings(root: string): Promise<CoreFinding[]> {
  const rows = await gitGrep(root, '(^|[^a-zA-Z0-9_.])(it|test|describe)\\.skip\\(', [':(glob)packages/*/test/**/*.ts', ':(glob)ops/*/test/**/*.ts']);
  return rows.map((row) => ({
    kind: 'skipped-test' as const,
    file: row.file,
    line: row.line,
    detail: `skipped: ${row.text.slice(0, 180)}`,
    key: keyFor('skipped-test', row.file, row.text),
  }));
}

interface EslintMessage { ruleId: string | null; severity: number; line: number; message: string; }
interface EslintResult { filePath: string; messages: EslintMessage[]; }

async function lintFindings(root: string): Promise<CoreFinding[]> {
  // eslint exits 1 when it found problems; that is still a report.
  const { stdout } = await run(
    'npx', ['eslint', 'packages', '--format', 'json'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error: { stdout?: string; code?: number }) => {
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('[')) return { stdout: error.stdout };
    throw error instanceof Error ? error : new Error('eslint did not produce a report');
  });
  const results = JSON.parse(stdout) as EslintResult[];
  return results.flatMap((result) => {
    const file = result.filePath.startsWith(`${root}/`) ? result.filePath.slice(root.length + 1) : result.filePath;
    return result.messages.map((message) => ({
      kind: 'lint-warning' as const,
      file,
      line: message.line,
      detail: `${message.ruleId ?? 'parse'}: ${message.message}`.slice(0, 200),
      key: keyFor('lint-warning', file, `${message.ruleId ?? 'parse'} ${message.message}`),
    }));
  });
}

/** Every finding of every enabled sense class, in a stable order. */
export async function scanCore(
  root: string,
  options: { lint?: boolean } = {},
): Promise<CoreFinding[]> {
  const findings = [
    ...(await todoFindings(root)),
    ...(await skippedTestFindings(root)),
    ...(options.lint !== false ? await lintFindings(root) : []),
  ];
  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

/** Findings not yet represented in the ledger, given its marker set. */
export function unfiledFindings(
  findings: readonly CoreFinding[],
  marked: ReadonlySet<string>,
): CoreFinding[] {
  return findings.filter((finding) => !marked.has(finding.key));
}
