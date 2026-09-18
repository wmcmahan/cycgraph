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

import { keySlug, legacyKeySlug } from './key-slug.js';

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
  /**
   * The key this finding was filed under before keys carried a digest.
   * Dedupe matches it so an already-filed finding with a long text is
   * not re-filed; {@link key} is what a new issue is marked with.
   */
  legacyKey: string;
}

function keysFor(kind: CoreFinding['kind'], file: string, text: string): { key: string; legacyKey: string } {
  return {
    key: `${kind}:${file}:${keySlug(text)}`,
    legacyKey: `${kind}:${file}:${legacyKeySlug(text)}`,
  };
}

/**
 * A line with its string-literal contents blanked, for re-testing a
 * grep match. A pattern spelled inside quotes is a fixture or a prompt,
 * not the thing itself — this scanner's own tests and agent
 * instructions mention `it.skip` and TODO precisely because the scanner
 * greps for them, and sensing those spellings files work that does not
 * exist. Line-level and unescaped-quote-naive, which is all a grep-
 * shaped scan can honestly claim anyway.
 */
function withoutStringLiterals(text: string): string {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
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
  // The actionable convention only: the marker word followed by a colon
  // or an owner in parentheses. The bare-word form matches prose that
  // talks about such comments rather than owing one.
  const rows = (await gitGrep(root, '(TODO|FIXME|HACK)(:|\\()', [':(glob)packages/*/src/**/*.ts', ':(glob)ops/*/src/**/*.ts']))
    .filter((row) => /(TODO|FIXME|HACK)[:(]/.test(withoutStringLiterals(row.text)));
  return rows.map((row) => ({
    kind: 'todo' as const,
    file: row.file,
    line: row.line,
    detail: row.text.slice(0, 200),
    ...keysFor('todo', row.file, row.text),
  }));
}

async function skippedTestFindings(root: string): Promise<CoreFinding[]> {
  const rows = (await gitGrep(root, '(^|[^a-zA-Z0-9_.])(it|test|describe)\\.skip\\(', [':(glob)packages/*/test/**/*.ts', ':(glob)ops/*/test/**/*.ts']))
    .filter((row) => /(^|[^a-zA-Z0-9_.])(it|test|describe)\.skip\(/.test(withoutStringLiterals(row.text)));
  return rows.map((row) => ({
    kind: 'skipped-test' as const,
    file: row.file,
    line: row.line,
    detail: `skipped: ${row.text.slice(0, 180)}`,
    ...keysFor('skipped-test', row.file, row.text),
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
      ...keysFor('lint-warning', file, `${message.ruleId ?? 'parse'} ${message.message}`),
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

/**
 * Findings not yet represented in the ledger, given its marker set.
 * A finding counts as represented under either its current key or the
 * pre-digest {@link CoreFinding.legacyKey} it may have been filed with.
 */
export function unfiledFindings(
  findings: readonly CoreFinding[],
  marked: ReadonlySet<string>,
): CoreFinding[] {
  return findings.filter((finding) => !marked.has(finding.key) && !marked.has(finding.legacyKey));
}
