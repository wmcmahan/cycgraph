/**
 * The audit charters: lens briefs, the lens × scope cross-product, and the
 * change-detection that steers the patrol.
 *
 * A charter is one lens (correctness, docs-truth, security, test-gaps)
 * applied to one scope of the repository. The cross-product is ordered
 * diagonally so a low cap still spreads across both dimensions, and
 * change-detection lets a run bias toward recently-touched scopes.
 * Everything here is pure (or git-read-only) so it can be pinned by tests.
 *
 * @module maintenance/repo-audit/charter
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The built-in lens briefs; a lens outside this set is passed through literally. */
export const LENS_BRIEFS: Record<string, string> = {
  correctness:
    'Hunt real defects: wrong fallbacks, silent failure paths, race conditions, schema or serialization mismatches, '
    + 'error handling that swallows what it should surface. A defect is only a finding when you can name the exact '
    + 'code path and the input or state that makes it misbehave.',
  'docs-truth':
    'Find claims the documentation makes that the source contradicts: described behavior that differs from the '
    + 'implementation, APIs documented with the wrong shape, features described that do not exist, and shipped '
    + 'behavior the docs omit entirely. Read the source first, then check what the docs say about it.',
  security:
    'Find gaps in the security posture: taint that fails to propagate, permission checks that can be bypassed, '
    + 'injection surfaces where external text reaches a prompt or command unsanitized, allowlists with holes, '
    + 'secrets that could reach an agent. Judge against the mandates in CLAUDE.md.',
  'test-gaps':
    'Find load-bearing behavior no test pins: exported functions whose edge cases are unasserted, invariants the '
    + 'code relies on that nothing would catch a regression in, and tests that assert vacuously. Name the behavior '
    + 'and the file that should test it.',
};

/** One auditor's assignment, delivered via the map node's task context. */
export interface AuditCharter {
  lens: string;
  scope: string;
  brief: string;
}

/** Workspace package directories, one audit scope each. */
export async function deriveScopes(root: string): Promise<string[]> {
  const scopes: string[] = [];
  for (const parent of ['packages', 'ops', 'apps']) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) {
        scopes.push(`${parent}/${entry.name}`);
      }
    }
  }
  return scopes;
}

/**
 * The lens × scope cross-product in diagonal order, so a cap keeps a spread
 * across both dimensions instead of exhausting one first.
 */
export function charterOrder(lenses: string[], scopes: string[]): Array<{ lens: string; scope: string }> {
  const pairs: Array<{ lens: string; scope: string; l: number; s: number }> = [];
  lenses.forEach((lens, l) => scopes.forEach((scope, s) => pairs.push({ lens, scope, l, s })));
  pairs.sort((a, b) => (a.l + a.s) - (b.l + b.s) || a.s - b.s || a.l - b.l);
  return pairs.map(({ lens, scope }) => ({ lens, scope }));
}

/**
 * Scopes with commits since the last audited head, excluding commits
 * authored by the maintenance identity itself. The pipeline's own merged
 * fixes were gated, adversarially reviewed, and merged moments ago;
 * counting them as "change" is the feedback loop that pinned every audit
 * run to the pipeline's current hot spot — audit finds, fix merges, the
 * scope is "changed" again, audit returns. Best-effort de-noising, not a
 * guarantee: a squash merge of a multi-commit PR is attributed to the PR's
 * opener, so some bot work slips through — the changed-slot cap in
 * `scheduleCharters` is the coverage guarantee.
 *
 * Any failure to answer — no recorded head, a head garbage-collected out of
 * history — yields the empty set: the run then leans entirely on
 * oldest-first rotation, which visits everything anyway.
 */
export async function changedScopesSince(
  repoRoot: string,
  lastHead: string | undefined,
  botAuthors: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
  if (lastHead === undefined) return new Set();
  try {
    const { stdout } = await promisify(execFile)(
      'git', ['log', `${lastHead}..HEAD`, '--name-only', '--format=%x01%an'], { cwd: repoRoot, timeout: 20_000 },
    );
    const SOH = String.fromCharCode(1);
    const scopes = new Set<string>();
    let skipCommit = false;
    for (const line of stdout.split('\n')) {
      if (line.startsWith(SOH)) {
        skipCommit = botAuthors.has(line.slice(1).trim());
        continue;
      }
      if (skipCommit) continue;
      const match = /^((?:packages|ops|apps)\/[^/]+)\//.exec(line);
      if (match) scopes.add(match[1]!);
    }
    return scopes;
  } catch {
    return new Set();
  }
}
