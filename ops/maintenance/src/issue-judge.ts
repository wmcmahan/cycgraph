/**
 * The per-class verdict for an issue fix, and its anti-gaming guards.
 *
 * A mechanical detector is satisfiable by removal: delete the TODO
 * comment, delete the skipped test, silence the lint rule. Each class
 * therefore carries a guard that tells a correction from a removal —
 * the docs workflow's `weakened` lesson, generalized. Everything here
 * is pure so it can be pinned by tests.
 *
 * @module maintenance/issue-judge
 */

import { issueMarkers, type IssueRef } from '@cycgraph/tools/git';
import type { CoreFinding } from './core-scan.js';

/** The finding an issue was filed for, recovered from its body. */
export interface IssueFinding {
  key: string;
  kind: CoreFinding['kind'] | 'audit';
  file: string;
}

const KINDS: readonly CoreFinding['kind'][] = ['todo', 'skipped-test', 'lint-warning'];

/**
 * Recover the finding a marker key names, or `undefined` when the key is
 * not one of ours.
 *
 * Audit keys are `audit:<title-slug>` — no file component, since the
 * issue body itself carries the finding's evidence and location. Every
 * other key is `<kind>:<file>:<detail>` over a known scan kind.
 */
export function findingFromKey(key: string): IssueFinding | undefined {
  if (key.startsWith('audit:')) {
    return key.length > 'audit:'.length ? { key, kind: 'audit', file: '' } : undefined;
  }
  const split = key.indexOf(':');
  if (split === -1) return undefined;
  const kind = key.slice(0, split);
  const file = key.slice(split + 1, key.lastIndexOf(':'));
  if (!(KINDS as readonly string[]).includes(kind) || file === '') return undefined;
  return { key, kind: kind as CoreFinding['kind'], file };
}

/** Recover the finding a filed issue carries, or `undefined` when it carries none. */
export function parseIssueFinding(body: string): IssueFinding | undefined {
  const keys = issueMarkers([{ number: 0, title: '', body } satisfies IssueRef]);
  const key = [...keys][0];
  if (key === undefined) return undefined;
  return findingFromKey(key);
}

const COMMENT_LINE = /^[+-]\s*(\/\/|\/\*|\*|\*\/)?\s*$|^[+-]\s*(\/\/|\/\*|\*)/;

/**
 * Whether a diff touches nothing but comments and blank lines — the
 * shape of a TODO deleted rather than done.
 */
export function commentOnlyChange(diff: string): boolean {
  const changed = diff.split('\n').filter((line) =>
    (line.startsWith('+') || line.startsWith('-'))
    && !line.startsWith('+++') && !line.startsWith('---'));
  if (changed.length === 0) return true;
  return changed.every((line) => COMMENT_LINE.test(line) || line.slice(1).trim() === '');
}

/** Test callsites in a file, skipped or not — deleting one lowers this. */
export function testCount(text: string): number {
  return (text.match(/(?<![A-Za-z0-9_.$])(it|test)[.(]/g) ?? []).length;
}

/** `eslint-disable` markers in a file — silencing a rule raises this. */
export function eslintDisableCount(text: string): number {
  return (text.match(/eslint-disable/g) ?? []).length;
}

/** What the judge needs to decide one class-guarded verdict. */
export interface IssueFixEvidence {
  finding: IssueFinding;
  beforeKeys: readonly string[];
  afterKeys: readonly string[];
  /** The finding's file, before and after the fix. */
  text: { before: string; after: string };
  /** The workspace's uncommitted diff. */
  diff: string;
}

/** The verdict shape the gate reads; mirrors the docs judge. */
export interface IssueFixVerdict {
  resolved: boolean;
  introduced_count: number;
  weakened: boolean;
  detail: string;
}

/**
 * The audit-kind verdict. A semantic finding has no mechanical detector,
 * so this checks only what a scan can prove: the tree was changed and no
 * new upkeep findings appeared. Fidelity to the finding is the diff
 * reviewer's judgment, which reads the finding text beside the diff.
 */
export function judgeAuditFix(
  evidence: { beforeKeys: readonly string[]; afterKeys: readonly string[]; diff: string },
): IssueFixVerdict {
  const before = new Set(evidence.beforeKeys);
  const introduced = evidence.afterKeys.filter((key) => !before.has(key)).length;
  const changed = evidence.diff.trim() !== '';
  return {
    resolved: changed,
    introduced_count: introduced,
    weakened: false,
    detail: !changed
      ? 'the workspace holds no change — an audit finding is resolved by editing what it names'
      : introduced > 0
        ? `changed the tree but introduced ${introduced} new finding(s)`
        : 'the tree was changed; the reviewer judges fidelity to the audited finding',
  };
}

/** Decide whether a fix resolved its finding without gaming its class. */
export function judgeIssueFix(evidence: IssueFixEvidence): IssueFixVerdict {
  const { finding, beforeKeys, afterKeys, text, diff } = evidence;
  const before = new Set(beforeKeys);
  const resolved = !afterKeys.includes(finding.key);
  const introduced = afterKeys.filter((key) => !before.has(key)).length;

  const weakened = resolved && (
    finding.kind === 'todo' ? commentOnlyChange(diff)
      : finding.kind === 'skipped-test' ? testCount(text.after) < testCount(text.before)
        : eslintDisableCount(text.after) > eslintDisableCount(text.before)
  );

  const why = finding.kind === 'todo'
    ? 'the comment was deleted without doing the work it describes — do the work, then remove it'
    : finding.kind === 'skipped-test'
      ? 'the test was deleted rather than un-skipped — make it run and pass'
      : 'the warning was silenced with eslint-disable rather than fixed — fix the code';

  return {
    resolved,
    introduced_count: introduced,
    weakened,
    detail: !resolved
      ? `'${finding.key}' is still present`
      : weakened
        ? why
        : introduced > 0
          ? `resolved '${finding.key}' but introduced ${introduced} new finding(s)`
          : `resolved ${finding.kind} in ${finding.file}`,
  };
}
