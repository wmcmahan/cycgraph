/**
 * Which repository a maintenance workflow maintains.
 *
 * @module maintenance/repo
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RUNTIME_CONFIG_ENV_VARS } from '@cycgraph/orchestrator/internal';
import { addIssueLabel, commentOnIssue } from '@cycgraph/tools/git';

/**
 * Resolve the target repository from a param value.
 *
 * An empty setting means "the one I am in", found by asking git rather
 * than assuming the working directory is a repository root — running
 * from a package inside a monorepo is the normal case, and cloning a
 * subdirectory is not a thing git will do.
 */
export async function resolveRepo(value: string): Promise<string> {
  if (value && value !== '.') {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Invalid repository path: empty value');
    if (trimmed.startsWith('-')) throw new Error(`Invalid repository path: ${value}`);
    if (trimmed.includes('\0') || /[\r\n]/.test(trimmed)) throw new Error(`Invalid repository path: ${value}`);
    return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  }
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    return process.cwd();
  }
}

/**
 * The top-level directories this repository organizes its workspaces
 * under. {@link repoMap} groups tracked files by these; a repository
 * with a different layout supplies its own through the maintenance
 * context.
 */
export const DEFAULT_WORKSPACE_ROOTS: readonly string[] = ['packages', 'ops', 'apps'];

/** The branch pull requests target and staleness is measured against. */
export const DEFAULT_BASE_BRANCH = 'main';

/**
 * A compact, deterministic map of the repository's tracked structure:
 * each workspace package with its description and source layout, plus
 * the root documents. Costs no model tokens to produce and spares an
 * exploring agent the many searches it would otherwise spend
 * rediscovering the same shape every run.
 */
export async function repoMap(
  root: string,
  workspaceRoots: readonly string[] = DEFAULT_WORKSPACE_ROOTS,
): Promise<string> {
  const { stdout } = await promisify(execFile)(
    'git', ['ls-files'], { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  const files = stdout.split('\n').filter(Boolean);

  const rootGroup = new RegExp(
    `^(${workspaceRoots.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/([^/]+)/(.*)$`,
  );
  const packages = new Map<string, { srcDirs: Set<string>; srcFiles: number; docs: string[] }>();
  const rootDocs: string[] = [];
  for (const file of files) {
    const match = file.match(rootGroup);
    if (!match) {
      if (/^[^/]+\.md$/i.test(file)) rootDocs.push(file);
      continue;
    }
    const key = `${match[1]}/${match[2]}`;
    const rest = match[3]!;
    const entry = packages.get(key) ?? { srcDirs: new Set<string>(), srcFiles: 0, docs: [] };
    const srcMatch = rest.match(/^src\/(?:([^/]+)\/)?[^/]+\.(ts|tsx)$/);
    if (srcMatch) {
      entry.srcFiles += 1;
      if (srcMatch[1] !== undefined) entry.srcDirs.add(srcMatch[1]);
    }
    if (/\.md$/i.test(rest) && !rest.includes('/')) entry.docs.push(rest);
    packages.set(key, entry);
  }

  const lines: string[] = [`Repository map (tracked files). Root docs: ${rootDocs.join(', ')}`];
  for (const [key, entry] of [...packages.entries()].sort()) {
    let description = '';
    try {
      const manifest = JSON.parse(await readFile(join(root, key, 'package.json'), 'utf8')) as { description?: string };
      description = manifest.description ?? '';
    } catch {
      // A directory without a manifest still lists its layout.
    }
    const dirs = [...entry.srcDirs].sort().join(' ');
    lines.push(`${key} — ${description}`.trim());
    if (entry.srcFiles > 0) lines.push(`  src (${entry.srcFiles} ts files): ${dirs || '(flat)'}`);
    if (entry.docs.length > 0) lines.push(`  docs: ${entry.docs.join(', ')}`);
  }
  const map = lines.join('\n');
  return map.length > 8_000 ? `${map.slice(0, 8_000)}\n… (truncated)` : map;
}

/**
 * Credentials the maintenance process itself holds, which nothing it
 * spawns inside a checked-out tree may read. The commands a workspace
 * check runs (`npm test`, `npx vitest run`) execute source an agent
 * just wrote from a semi-trusted issue body, so a token left in the
 * environment is a token that source can post anywhere: GH_TOKEN
 * carries repo write (push, comment, label), the model keys carry
 * billable API access, and the registry tokens carry publish rights.
 * A new credential the workflows set belongs here the day it is added.
 */
export const MAINTENANCE_SECRET_ENV_VARS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MAINTENANCE_PAT',
  'REVIEW_PAT',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];

/**
 * The variables a workspace check legitimately needs to run — the
 * allow-list {@link checksEnv} copies. Locale categories (`LC_CTYPE`,
 * `LC_NUMERIC`, …) are matched by their `LC_` prefix in addition to these.
 */
export const CHECK_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'SHELL', 'PWD', 'USER', 'LOGNAME', 'CI',
];

/**
 * The minimal environment for anything a workflow spawns inside a
 * checked-out tree (checks, acceptance commands, benches), built by
 * allow-list so it fails closed. Those commands run source an agent just
 * wrote from a semi-trusted issue body, so a credential left in the
 * environment is one that source can read from `process.env` and post
 * anywhere. A deny-list cannot enumerate what to remove — the cloud, OIDC,
 * and alternate-model keys a deployment sets are not knowable here — so
 * this copies only what a repository check needs (`npm test`, `npx vitest`,
 * `npx tsc`) and drops everything else, secrets included, by construction.
 * It also drops, for correctness, what a deny-list used to remove by hand:
 * DATABASE_URL (the postgres suite wipes tables when it sees one), ambient
 * GIT_* identity, the raised LOG_LEVEL, and the engine runtime-config
 * knobs are none of them on the allow-list.
 */
export function checksEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CHECK_ENV_ALLOWLIST.includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  return env;
}

/**
 * Environment for the tune trial subprocess, which *is* the maintenance
 * process re-running `run.ts`: it calls the model and the GitHub API on
 * the run's behalf, so unlike a workspace check it keeps the run's
 * configuration (model, provider, Ollama URL). It is not the security
 * boundary — the untrusted commands it spawns downstream use
 * {@link checksEnv}. It drops only what would corrupt a trial or leak into
 * a commit identity: its own credentials (a caller restores them through
 * {@link maintenanceSecrets}), the database URLs (a trial must not touch
 * the corpus), ambient GIT_* identity, the raised LOG_LEVEL, and the engine
 * runtime-config knobs (so arms differ only by the edit under test).
 */
export function maintenanceRunEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of MAINTENANCE_SECRET_ENV_VARS) delete env[name];
  delete env['DATABASE_URL'];
  delete env['APP_DATABASE_URL'];
  delete env['PLATFORM_DATABASE_URL'];
  delete env['SUPABASE_DB_URL'];
  delete env['GIT_AUTHOR_NAME'];
  delete env['GIT_AUTHOR_EMAIL'];
  delete env['GIT_COMMITTER_NAME'];
  delete env['GIT_COMMITTER_EMAIL'];
  delete env['LOG_LEVEL'];
  for (const name of RUNTIME_CONFIG_ENV_VARS) delete env[name];
  return env;
}

/**
 * The maintenance run's own credentials, as a spread onto a
 * `checksEnv()` base. Only for a subprocess that *is* the maintenance
 * process — a tune trial re-running `run.ts`, which calls the model and
 * the GitHub API on the run's behalf — never for a command that
 * executes source from a checked-out workspace.
 */
export function maintenanceSecrets(): NodeJS.ProcessEnv {
  const secrets: NodeJS.ProcessEnv = {};
  for (const name of MAINTENANCE_SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  return secrets;
}

/**
 * Comment authors whose text a workflow may treat as instructions.
 * Commenting needs no repository permission, so association is the only
 * trust signal a comment carries; everything below COLLABORATOR is an
 * arbitrary account on a public repository.
 */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Label marking a PR the maintenance loop may push to. Applied to
 * bot-created PRs at birth and by hand to any PR a maintainer wants the
 * loop to manage; GitHub only lets triage+ users apply labels, so the
 * label itself is the consent check. pr-revise.yml gates on the same
 * literal name.
 */
export const MANAGED_LABEL = 'maintenance-managed';

/**
 * The label that approves an issue or ticket for the automated fix
 * queue. Applied by a human, or by the audit and upkeep workflows filing
 * pre-approved with `--approve`; the issue-fix picker selects only issues
 * that carry it. The `.github/workflows/*.yml` event filters gate on the
 * same literal, so a rename must change both this and them together.
 */
export const APPROVED_LABEL = 'maintenance-approved';

/**
 * The label a managed PR carries when the automated loop has given up
 * on it: review inconclusive after every retry, a review that could
 * not be submitted, or a failed revision run. Applied automatically at
 * the moment of giving up and removed by the next successful pass, so
 * a PR is always in exactly one visible state — merge armed, revision
 * in flight, or waiting on a human — and the PR list can filter for
 * the ones that need a decision.
 */
export const NEEDS_HUMAN_LABEL = 'needs-human';

/** The two issue-ledger operations flagging runs on, injectable so tests fake them inline. */
export interface FlagNeedsHumanOps {
  addLabel: typeof addIssueLabel;
  comment: typeof commentOnIssue;
}

/**
 * Flag an issue as waiting on a human: apply {@link NEEDS_HUMAN_LABEL},
 * then leave the explanatory comment. The label comes first and gates
 * the comment — the label is what stops the picker from re-burning the
 * issue, so commenting without it would repeat once per re-pick; a
 * failed label returns unflagged with no comment posted.
 */
export async function flagNeedsHuman(
  repoRoot: string,
  issueNumber: number,
  body: string,
  options: { token?: string; ops?: FlagNeedsHumanOps; label?: string } = {},
): Promise<{ flagged: boolean; detail: string }> {
  const ops = options.ops ?? { addLabel: addIssueLabel, comment: commentOnIssue };
  const auth = options.token !== undefined ? { token: options.token } : {};
  const label = await ops.addLabel(repoRoot, issueNumber, options.label ?? NEEDS_HUMAN_LABEL, auth);
  if (!label.ok) return { flagged: false, detail: `label failed: ${label.detail}` };
  const comment = await ops.comment(repoRoot, issueNumber, body, auth);
  return { flagged: true, detail: comment.detail };
}

/**
 * The comment a flagged issue receives. It is deliberately generic: a
 * give-up cause, check output, or error message can carry paths, tokens,
 * or environment details, so the specifics stay in the run's own log and
 * never reach the public issue.
 */
export function needsHumanNotice(workflow: string, needsHumanLabel: string): string {
  return [
    `I ran into a problem while working on this issue.`,
    `I've added the \`${needsHumanLabel}\` label for your attention.`,
  ].join('\n');
}

/**
 * The give-up node's action: flag the picked issue waiting on a human
 * because the run ended without a pull request. The posted comment is
 * {@link needsHumanNotice}; `cause` names which dead end sent the run
 * here and is reported only in the returned `detail`. The result carries
 * `flagged`, which `run.ts` reads into the run's `gave_up` field, so a
 * tried-and-abandoned run reports distinctly from a nothing-to-do one.
 */
export async function giveUpNeedsHuman(
  repoRoot: string,
  issueNumber: number,
  workflow: string,
  cause: string,
  needsHumanLabel: string,
  options: { token?: string; ops?: FlagNeedsHumanOps } = {},
): Promise<{ flagged: boolean; issue_number: number; detail: string }> {
  const result = await flagNeedsHuman(repoRoot, issueNumber, needsHumanNotice(workflow, needsHumanLabel), {
    label: needsHumanLabel,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.ops !== undefined ? { ops: options.ops } : {}),
  });
  return {
    flagged: result.flagged,
    issue_number: issueNumber,
    detail: result.flagged ? `flagged #${issueNumber} (${cause}); ${result.detail}` : `${cause}; ${result.detail}`,
  };
}

/**
 * An `onFatal` cleanup that flags the picked issue waiting on a human
 * after an engine-level death (a budget breach) that bypasses the
 * give-up node — without it, the issue stays approved-but-orphaned, its
 * label event already spent, so nothing re-queues it. `getPicked` reads
 * the issue held in the build's closure. The error is reported in the
 * returned line only; the issue gets {@link needsHumanNotice}.
 */
export function fatalNeedsHuman(
  repoRoot: string,
  getPicked: () => number | undefined,
  workflow: string,
  needsHumanLabel: string,
  token?: string,
  ops?: FlagNeedsHumanOps,
): (error: unknown) => Promise<string | undefined> {
  return async (error) => {
    const issue = getPicked();
    if (issue === undefined) return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const result = await flagNeedsHuman(repoRoot, issue, needsHumanNotice(workflow, needsHumanLabel), {
        label: needsHumanLabel,
        ...(token !== undefined ? { token } : {}),
        ...(ops !== undefined ? { ops } : {}),
      });
      return result.flagged
        ? `fatal-run cleanup: #${issue} flagged ${needsHumanLabel} after: ${reason}`
        : `fatal-run cleanup on #${issue}: ${result.detail}`;
    } catch (cleanupError) {
      return `fatal-run cleanup failed on #${issue}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  };
}

/**
 * The mention that dispatches maintenance workflows from PR comments.
 * Emitted deliberately by pr-review's handoff; relayed text must pass
 * through {@link stripMentions} so arbitrary prose never carries it.
 */
export const WORKFLOW_MENTION = '@cycgraph';

/** Neutralize workflow-dispatching mentions inside relayed text. */
export function stripMentions(text: string): string {
  return text.replace(/@cycgraph/gi, 'cycgraph');
}

/**
 * The house coding standards, distilled for agent prompts: the rules an
 * editing or reviewing agent most often breaks. The pointer to the
 * repository's own convention document, when one exists, is added
 * separately by `resolveStandardsBrief`, so this carries the rules alone.
 */
export const STANDARDS_BRIEF = [
  'House coding standards for this repository:',
  'Comments are definitional: JSDoc on exports stating the contract, rare inline notes only for what the code cannot say (an invariant, a wire-format fact, a security rationale). Never development history, never narration of the line below.',
  'Tests use it() with present-tense behavior names (no "should"), arrange-act-assert, exact assertions (toBe/toEqual over toBeTruthy), NO inline comments inside test bodies, and no timers or network.',
  'ESM imports carry .js extensions; imports across packages use @cycgraph/* names, never relative paths.',
  'TypeScript identifiers are camelCase; snake_case belongs only to serialization boundaries (Zod schema fields, wire payloads, stream events).',
  'State changes go through reducers, agents are configs rather than classes, and every input/output boundary has a Zod schema.',
].join(' ');

/**
 * Changeset discipline for agents that edit published-package source.
 * Shared verbatim by every workflow whose editor can touch packages/ so
 * the release convention cannot drift between prompts.
 */
export const CHANGESET_INSTRUCTION = [
  'When your edits change the BEHAVIOR of a published package under packages/ (any package whose package.json lacks "private": true), also create_file one changeset at .changeset/<short-kebab-name>.md:',
  'a "---" line, one line per affected package like \'"@cycgraph/orchestrator": patch\' (patch for a fix, minor for new capability), a closing "---" line, then a one-or-two-sentence summary of what changed and why it matters to a consumer.',
  'Docs-only, test-only, and ops/ changes need no changeset.',
].join(' ');
