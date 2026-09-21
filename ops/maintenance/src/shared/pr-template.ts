/**
 * Evidence for this repository's PR template, derived from a delivery's
 * own facts: the branch diff, the checks that gated the commit, and the
 * review that approved it. Each checkbox is ticked only with the fact
 * that justifies it; blocks the diff never enters are marked not
 * applicable, as the template's own skip notes instruct; what the run
 * cannot vouch for is annotated, never ticked. The generic filling
 * machinery lives in `@cycgraph/tools`.
 *
 * @module maintenance/pr-template
 */

import type { PrCheckTick, PrEvidence } from '@cycgraph/tools/git';

/** New-file paths a unified diff touches. */
export function diffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) paths.push(line.slice(6));
  }
  return paths;
}

/** Lines the diff adds, without their `+` prefix. */
function addedLines(diff: string): string[] {
  return diff.split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

/**
 * Details with their `Closes #N.` markers removed, for prose sections:
 * the numbers ride the evidence's `closes` field into the Related
 * issues section instead of repeating through Summary and Changes.
 */
export function stripCloses(details: string[]): string[] {
  return details.map((detail) => detail.replace(/(^|\s)Closes #\d+\.\s*/g, '$1').trim());
}

/** Issue numbers named as `Closes #N` anywhere in the details. */
export function closesIn(details: string[]): number[] {
  const closes = new Set<number>();
  for (const detail of details) {
    for (const match of detail.matchAll(/Closes #(\d+)/g)) closes.add(Number(match[1]));
  }
  return [...closes];
}

const TEST_FILE = /(^|\/)test\/|\.test\.[cm]?[jt]sx?$/;
const DB_PATH = /^packages\/(orchestrator-postgres\/|memory\/src\/schemas\/)/;
const SECURITY_PATH = /^packages\/orchestrator\/src\/(security|mcp|cost)\/|taint|permission|budget|ssrf/i;
const ENGINE_STATE_PATH = /^packages\/orchestrator\/src\//;
const NO_CHANGESET_NEEDED = /(^|\/)test\/|\.test\.[cm]?[jt]sx?$|^apps\/docs\/|\.md$|^packages\/evals\//;
const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"])/i;
const RELATIVE_IMPORT = /from\s+['"](\.[^'"]*)['"]/;
const CROSS_PACKAGE_IMPORT = /from\s+['"][^'"]*\.\.\/\.\.\/packages\//;

/** Run facts the template fill draws on, beyond the diff itself. */
export interface TemplateFacts {
  /** Check commands that ran clean in the workspace before the commit. */
  checks?: string[];
  /** Whether an advisory reviewer approved the diff against the standards. */
  reviewed?: boolean;
  /** Commit details, mined for `Closes #N`. */
  details?: string[];
}

/**
 * The ticks, not-applicable blocks, and closed issues a delivery can
 * honestly claim on `.github/PULL_REQUEST_TEMPLATE.md`.
 */
export function templateEvidence(
  diff: string,
  facts: TemplateFacts = {},
): Pick<PrEvidence, 'ticks' | 'notApplicable' | 'closes'> {
  const paths = diffPaths(diff);
  const added = addedLines(diff);
  const ticks: PrCheckTick[] = [];
  const notApplicable: { heading: string; reason: string }[] = [];

  // The box claims tests passed, so it only ticks when a test-shaped
  // command actually ran; a lint-only gate is stated, not claimed.
  const checks = facts.checks ?? [];
  const testish = checks.filter((command) => /\btest\b|vitest/.test(command));
  if (testish.length > 0) {
    ticks.push({ match: 'All existing tests pass', note: `\`${testish.join(' && ')}\` ran clean in the workspace before commit` });
  } else if (checks.length > 0) {
    ticks.push({ match: 'All existing tests pass', checked: false, note: `only \`${checks.join(' && ')}\` ran in the workspace — tests were not executed` });
  }
  const testFiles = paths.filter((path) => TEST_FILE.test(path));
  if (testFiles.length > 0) {
    ticks.push({ match: 'New tests added', note: `${testFiles.length} test file(s) changed` });
  }
  ticks.push({ match: 'Tested manually', checked: false, note: 'not performed — automated fix, verified by re-scan and repository checks' });

  if (facts.reviewed === true) {
    ticks.push({ match: 'coding standards', note: 'advisory reviewer approved the diff against CLAUDE.md' });
  }
  ticks.push({ match: 'Zod schemas', checked: false, note: 'not verified — confirm if the diff adds an input/output boundary' });
  if (!paths.some((path) => ENGINE_STATE_PATH.test(path))) {
    ticks.push({ match: 'No direct state mutation', note: 'the diff does not touch the engine' });
  }
  if (!added.some((line) => RELATIVE_IMPORT.test(line) && !/\.(js|json)['"]/.test(line))) {
    ticks.push({ match: '`.js` extension', note: 'no extensionless relative imports added' });
  }
  if (!added.some((line) => CROSS_PACKAGE_IMPORT.test(line))) {
    ticks.push({ match: 'Cross-workspace imports', note: 'no relative imports across package boundaries added' });
  }
  if (!added.some((line) => SECRETISH.test(line))) {
    ticks.push({ match: 'No secrets', note: 'no secret-shaped strings in the diff' });
  }
  if (!added.some((line) => /console\.(warn|error)/.test(line))) {
    ticks.push({ match: 'console.warn', note: 'none added in this diff' });
  }

  if (!paths.some((path) => DB_PATH.test(path))) {
    notApplicable.push({
      heading: 'Database & data integrity',
      reason: 'no changes under packages/orchestrator-postgres or the memory schemas',
    });
  }
  if (!paths.some((path) => SECURITY_PATH.test(path))) {
    notApplicable.push({
      heading: 'Security',
      reason: 'no changes to permission, MCP, taint, or budget paths',
    });
  }

  const changesets = paths.filter((path) => path.startsWith('.changeset/') && path.endsWith('.md'));
  if (changesets.length > 0) {
    ticks.push({ match: 'Ran `npx changeset`', note: `changeset included: ${changesets.join(', ')}` });
  } else if (paths.length > 0 && paths.every((path) => NO_CHANGESET_NEEDED.test(path))) {
    ticks.push({ match: 'docs / tests / evals-only', note: 'the diff touches no shipped source' });
  } else {
    ticks.push({ match: 'Ran `npx changeset`', checked: false, note: 'no changeset in the diff — add one before merge if this ships' });
  }

  const closes = closesIn(facts.details ?? []);
  return { ticks, notApplicable, ...(closes.length > 0 ? { closes } : {}) };
}
