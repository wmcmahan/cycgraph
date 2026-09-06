/**
 * What is wrong with a repository's documentation, mechanically.
 *
 * The improvement loop can only optimise what it can score, and prose
 * quality is not scoreable. Staleness is: a link whose target moved, a
 * path that no longer exists, a command nobody can run. Every detector
 * here answers yes or no against the filesystem, so a docs run has an
 * objective verdict — the finding it targeted is gone, and no new ones
 * appeared — and the loop has a fitness signal it can trust.
 *
 * @module maintenance/docs-scan
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One thing a document says that the repository contradicts. */
export interface DocsFinding {
  kind: 'broken-link' | 'missing-path' | 'unknown-script';
  /** Document holding the claim, relative to the repository root. */
  file: string;
  line: number;
  /** What the document pointed at. */
  target: string;
  /** One line a reader (or an agent) can act on. */
  detail: string;
  /**
   * What the claim probably should say, computed from the repository.
   *
   * The scan already knows what exists; making a fixer rediscover it by
   * search is how a small model ends up deleting the claim instead.
   */
  candidates: string[];
}

/** What narrows a scan's findings to the work one run should take. */
export interface ScanScope {
  /** Keep only findings in documents under these paths. Empty keeps all. */
  roots?: string[];
  /** Drop findings in documents under these paths. */
  exclude?: string[];
  /**
   * Diff mode: keep only findings a change plausibly staled — the
   * document itself changed, the path it points at changed, or, for a
   * script claim, some package manifest changed.
   */
  changedPaths?: string[];
  /** Drop findings in documents an open maintenance PR already touches. */
  deferredFiles?: string[];
}

function underAny(file: string, paths: string[]): boolean {
  return paths.some((path) => file === path || file.startsWith(`${path}/`));
}

/** Apply a `ScanScope` to a finding list, preserving order. */
export function scopeFindings(findings: DocsFinding[], scope: ScanScope): DocsFinding[] {
  return findings.filter((finding) => {
    if (scope.roots !== undefined && scope.roots.length > 0 && !underAny(finding.file, scope.roots)) return false;
    if (scope.exclude !== undefined && underAny(finding.file, scope.exclude)) return false;
    if (scope.deferredFiles !== undefined && scope.deferredFiles.includes(finding.file)) return false;
    if (scope.changedPaths !== undefined) {
      const changed = scope.changedPaths;
      const staled = changed.includes(finding.file)
        || (finding.kind === 'unknown-script'
          ? changed.some((path) => path === 'package.json' || path.endsWith('/package.json'))
          : changed.some((path) => path === finding.target || path.endsWith(`/${finding.target}`)
            || finding.target.endsWith(`/${path}`)));
      if (!staled) return false;
    }
    return true;
  });
}

/** Directories no documentation scan should descend into. */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', '.next', 'coverage',
  '.playground', '.cycgraph', 'bench-data', '.turbo',
]);

const DOC_EXTENSIONS = /\.(md|mdx)$/;

/**
 * Every markdown document under `root`, repository-relative.
 *
 * Tracked files only where git can say: documentation the repository
 * ignores is scratch, and correcting it is work nobody asked for.
 */
export async function findDocs(root: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files', '*.md', '*.mdx'], { maxBuffer: 8 * 1024 * 1024 });
    const tracked = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (tracked.length > 0) return tracked.sort();
  } catch {
    // Not a repository, or git is unavailable: fall back to walking.
  }

  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.changeset') continue;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (DOC_EXTENSIONS.test(entry.name)) found.push(relative(root, full));
    }
  };

  await walk(root);
  return found.sort();
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Who defines a script: the repository root, or a workspace package. */
interface ScriptOwners {
  /** Workspace directories defining it; the empty string means the root. */
  owners: Set<string>;
  /** How a reader at the repository root would invoke it. */
  invocation: string;
}

/**
 * Every script the repository defines, and who defines it.
 *
 * Ownership matters: a root-level document telling a reader to run
 * `npm run x` is wrong unless the ROOT defines `x`, however many packages
 * happen to define a script by that name. Ignoring that turns a genuinely
 * broken instruction into a passing one the moment any package adds a
 * script with the same name.
 */
async function knownScripts(root: string): Promise<Map<string, ScriptOwners>> {
  const scripts = new Map<string, ScriptOwners>();

  const read = async (path: string, workspace?: string): Promise<void> => {
    try {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { scripts?: Record<string, unknown> };
      for (const name of Object.keys(manifest.scripts ?? {})) {
        const invocation = workspace ? `npm run ${name} --workspace=${workspace}` : `npm run ${name}`;
        const entry = scripts.get(name);
        if (entry) {
          entry.owners.add(workspace ?? '');
          // The root's own invocation is what a reader can run directly.
          if (!workspace) entry.invocation = invocation;
        } else {
          scripts.set(name, { owners: new Set([workspace ?? '']), invocation });
        }
      }
    } catch {
      // A manifest that will not parse is not this scan's finding to make.
    }
  };

  await read(join(root, 'package.json'));
  for (const group of ['packages', 'apps']) {
    let entries;
    try {
      entries = await readdir(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await read(join(root, group, entry.name, 'package.json'), `${group}/${entry.name}`);
      }
    }
  }
  return scripts;
}

/** How much two names look like one another, for ranking candidates. */
function similarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  const shared = [...new Set(left.split(/[^a-z0-9]+/))]
    .filter((part) => part.length > 2 && right.includes(part)).length;
  return shared > 0 ? 0.5 : 0;
}

// A relative markdown link, ignoring anchors and external schemes.
const LINK = /\]\((\.{1,2}\/[^)\s#]+)/g;
// A repository path a document names in prose or a code fence.
const REPO_PATH = /\b((?:packages|apps|docs|examples)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|md|mdx|sql|json))\b/g;
// An npm script a reader is told to run, with the workspace flag that
// often follows it — `npm run evals --workspace=packages/evals` names a
// package script and is correct, however the root's manifest looks.
const SCRIPT = /\bnpm run ([a-z][a-z0-9:-]*)((?:\s+--[a-z-]+(?:=\S+)?)*)/g;
// A line that removes or creates a path is not claiming it exists.
const MUTATES_PATH = /(^|\s)(rm|touch|mkdir|cp|mv|>)\s/;

/**
 * The package a document belongs to, if any — the nearest ancestor with a
 * manifest. A README inside a package writes paths relative to it.
 */
async function packageRootOf(root: string, doc: string): Promise<string | undefined> {
  let dir = dirname(join(root, doc));
  while (dir.startsWith(root) && dir !== root) {
    if (await exists(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Whether a path reference resolves from anywhere a reader would read it:
 * the repository root, the document's own directory, or its package root.
 * Checking only the repository root turns every package-relative example
 * path into a phantom finding, which would send a fixer editing prose that
 * was already correct.
 */
async function resolvesSomewhere(bases: readonly string[], target: string): Promise<boolean> {
  for (const base of bases) {
    if (await exists(join(base, target))) return true;
  }
  return false;
}



/** Every file under `root`, repository-relative, skipping build output. */
async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(relative(root, full));
    }
  };
  await walk(root);
  return found;
}

/** Repository files grouped by filename, for suggesting where something moved. */
async function indexByBasename(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let paths: string[] = [];
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files'], { maxBuffer: 32 * 1024 * 1024 });
    paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    // Not a repository: walk instead, so suggestions still work.
    paths = await walkFiles(root);
  }
  if (paths.length === 0) paths = await walkFiles(root);
  for (const path of paths) {
    const name = basename(path);
    const bucket = index.get(name);
    if (bucket) bucket.push(path);
    else index.set(name, [path]);
  }
  return index;
}

/**
 * Scan a repository's documentation. Findings are ordered by file then
 * line, so an unattended loop that fixes the first one makes deterministic
 * progress through the list rather than revisiting the same document.
 */
export async function scanDocs(root: string): Promise<DocsFinding[]> {
  const docs = await findDocs(root);
  const scripts = await knownScripts(root);
  const byBasename = await indexByBasename(root);
  const findings: DocsFinding[] = [];

  /** Repository files whose name matches what a broken reference points at. */
  const pathCandidates = (target: string): string[] =>
    (byBasename.get(basename(target)) ?? []).slice(0, 4);

  /** Existing invocations closest to a command that does not exist. */
  const scriptCandidates = (target: string): string[] =>
    [...scripts.entries()]
      .map(([name, entry]) => ({ invocation: entry.invocation, score: similarity(target, name) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((entry) => entry.invocation);

  for (const doc of docs) {
    const absolute = join(root, doc);
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const docDir = dirname(join(root, doc));
    const packageRoot = await packageRootOf(root, doc);
    const bases = [root, docDir, ...(packageRoot ? [packageRoot] : [])];
    const workspaceOf = packageRoot ? relative(root, packageRoot) : undefined;

    let inFence = false;
    for (const [index, line] of lines.entries()) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      for (const match of line.matchAll(LINK)) {
        const target = match[1]!;
        if (await exists(resolve(dirname(absolute), target))) continue;
        findings.push({
          kind: 'broken-link',
          file: doc,
          line: index + 1,
          target,
          detail: `link to '${target}' resolves to nothing — find where that file moved, or drop the link`,
          candidates: pathCandidates(target),
        });
      }

      // A path in `rm …` is a thing the reader is told to delete, and a
      // generated artifact is absent by design.
      const mutatesPath = MUTATES_PATH.test(line);
      for (const match of line.matchAll(REPO_PATH)) {
        const target = match[1]!;
        if (mutatesPath) continue;
        if (await resolvesSomewhere(bases, target)) continue;
        findings.push({
          kind: 'missing-path',
          file: doc,
          line: index + 1,
          target,
          detail: `'${target}' does not exist in the repository — update it to where that code lives now`,
          candidates: pathCandidates(target),
        });
      }

      for (const match of line.matchAll(SCRIPT)) {
        const target = match[1]!;
        const owners = scripts.get(target)?.owners;

        // Prose naming a command is a reference, not an instruction: it is
        // wrong only when no such script exists at all, which is what a
        // rename leaves behind. Inside a fence the command is meant to be
        // copied, so it must run from where the document implies.
        if (!inFence) {
          if (owners) continue;
        } else {
          const named = /--workspace=([\w@./-]+)/.exec(match[2] ?? '')?.[1];
          if (named ? owners?.has(named) : (owners?.has('') || (workspaceOf && owners?.has(workspaceOf)))) continue;
        }
        findings.push({
          kind: 'unknown-script',
          file: doc,
          line: index + 1,
          target,
          detail: inFence
            ? `'npm run ${target}' cannot be run as written from here — name the workspace that defines it`
            : `no package defines an 'npm run ${target}' script — correct the command or remove it`,
          candidates: scriptCandidates(target),
        });
      }
    }
  }

  return findings;
}

/** A stable identity for a finding, so two scans can be compared. */
export function findingKey(finding: DocsFinding): string {
  return `${finding.kind}:${finding.file}:${finding.target}`;
}

/** What one fix attempt achieved, judged by re-scanning. */
export interface DocsVerdict {
  resolved: boolean;
  /** Findings that appeared which were not there before. */
  introduced: DocsFinding[];
  /** `introduced.length`, as a scalar a gate expression can compare. */
  introduced_count: number;
  remaining: number;
  /**
   * The finding went away because the claim was deleted rather than
   * corrected. A detector is satisfied either way, which makes deletion
   * the cheapest way to game a mechanical verdict — so it is called out
   * and refused rather than counted as a fix.
   */
  weakened: boolean;
  detail: string;
}

/**
 * How many references of a finding's kind a document makes.
 *
 * A correction replaces one reference with another and leaves the count
 * unchanged; a deletion lowers it. That difference is what separates
 * fixing the claim from removing it.
 */
export function countReferences(kind: DocsFinding['kind'], text: string): number {
  const pattern = kind === 'broken-link' ? LINK : kind === 'missing-path' ? REPO_PATH : SCRIPT;
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].length;
}

/**
 * Compare a scan taken after a fix against the finding it targeted.
 *
 * Pass the document's text before and after to detect a claim that was
 * deleted rather than corrected.
 */
export function judgeFix(
  targeted: DocsFinding,
  before: readonly DocsFinding[],
  after: readonly DocsFinding[],
  text?: { before: string; after: string },
  // The complete before key set, for a caller whose `before` list was
  // capped in transit; without it, findings past the cap would be
  // miscounted as introduced.
  beforeKeys?: readonly string[],
): DocsVerdict {
  const beforeSet = new Set(beforeKeys ?? before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));
  const resolved = !afterKeys.has(findingKey(targeted));
  const introduced = after.filter((finding) => !beforeSet.has(findingKey(finding)));
  const weakened = resolved && text !== undefined
    && countReferences(targeted.kind, text.after) < countReferences(targeted.kind, text.before);

  return {
    resolved,
    introduced,
    introduced_count: introduced.length,
    remaining: after.length,
    weakened,
    detail: !resolved
      ? `'${targeted.target}' in ${targeted.file} is still wrong`
      : weakened
        ? `'${targeted.target}' was removed from ${targeted.file} rather than corrected — replace it with the reference that is actually right`
        : introduced.length > 0
          ? `fixed '${targeted.target}' but introduced ${introduced.length} new finding(s)`
          : `fixed '${targeted.target}' in ${targeted.file}; ${after.length} finding(s) left`,
  };
}
