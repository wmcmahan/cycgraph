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
 * A compact, deterministic map of the repository's tracked structure:
 * each workspace package with its description and source layout, plus
 * the root documents. Costs no model tokens to produce and spares an
 * exploring agent the many searches it would otherwise spend
 * rediscovering the same shape every run.
 */
export async function repoMap(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    'git', ['ls-files'], { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  const files = stdout.split('\n').filter(Boolean);

  const packages = new Map<string, { srcDirs: Set<string>; srcFiles: number; docs: string[] }>();
  const rootDocs: string[] = [];
  for (const file of files) {
    const match = file.match(/^(packages|ops|apps)\/([^/]+)\/(.*)$/);
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
 * Environment for anything a workflow spawns inside a checked-out tree
 * (checks, acceptance commands, benches): the process env minus four
 * categories the maintenance run holds for itself — database
 * credentials, ambient git identity, the raised log level, and the
 * engine's runtime-config tuning knobs. Each category, inherited, makes
 * the workspace behave differently from every other environment: the
 * orchestrator-postgres suite activates on DATABASE_URL and cleans every
 * table it touches (a production wipe, not a hypothetical), GIT_* vars
 * override the identities tests commit with, LOG_LEVEL floods the suite
 * output with engine JSON logs, and a tuning knob retunes the engine the
 * suite is asserting defaults against.
 */
export function checksEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Every credential the postgres adapter reads: the primary URL, the
  // RLS-subject app role, the BYPASSRLS platform role, and the local
  // convenience alias. A new connection var belongs here before it is
  // ever set in a deployment.
  delete env['DATABASE_URL'];
  delete env['APP_DATABASE_URL'];
  delete env['PLATFORM_DATABASE_URL'];
  delete env['SUPABASE_DB_URL'];
  // Ambient git identity: GIT_AUTHOR_/GIT_COMMITTER_ vars override the
  // explicit `-c user.*` a test's own commits pass, so the identity CI
  // sets for the workflow's commits makes identity-asserting tests fail
  // in the workspace while passing everywhere else.
  delete env['GIT_AUTHOR_NAME'];
  delete env['GIT_AUTHOR_EMAIL'];
  delete env['GIT_COMMITTER_NAME'];
  delete env['GIT_COMMITTER_EMAIL'];
  // The maintenance run raises its own LOG_LEVEL for diagnosable CI
  // logs; inherited into a workspace's test suite, every engine those
  // tests spawn logs at info too, burying the suite's real failures
  // under multi-KB JSON log lines. Deleting restores the logger default.
  delete env['LOG_LEVEL'];
  // Engine tuning knobs: set for the maintenance run's own engine, they
  // retune the engine the workspace suite tests — MAX_MEMORY_PROMPT_BYTES
  // =204800 made the truncation tests' oversized inputs read as under-cap,
  // failing the suite in the clone while it passed everywhere else. The
  // list is imported from runtime-config itself, so a new knob is
  // scrubbed the day it exists.
  for (const name of RUNTIME_CONFIG_ENV_VARS) delete env[name];
  return env;
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
  options: { token?: string; ops?: FlagNeedsHumanOps } = {},
): Promise<{ flagged: boolean; detail: string }> {
  const ops = options.ops ?? { addLabel: addIssueLabel, comment: commentOnIssue };
  const auth = options.token !== undefined ? { token: options.token } : {};
  const label = await ops.addLabel(repoRoot, issueNumber, NEEDS_HUMAN_LABEL, auth);
  if (!label.ok) return { flagged: false, detail: `label failed: ${label.detail}` };
  const comment = await ops.comment(repoRoot, issueNumber, body, auth);
  return { flagged: true, detail: comment.detail };
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
 * The house coding standards, distilled for agent prompts. CLAUDE.md is
 * the authority; this brief carries the rules an editing or reviewing
 * agent most often breaks without it.
 */
export const STANDARDS_BRIEF = [
  'House standards (.claude/CLAUDE.md in the repository is the full authority — read it when in doubt):',
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
