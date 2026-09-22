/**
 * Repository-specific configuration a maintenance run carries.
 *
 * The workflows default every field to this repository's own values, so
 * nothing changes for a run that supplies no context. The point of the
 * seam is that a run maintaining a *different* repository overrides these
 * rather than editing constants: the maintainer is being readied to run
 * against repositories other than the one it lives in, and this is where
 * the "which repository" answers gather as they are lifted out of
 * scattered module constants. See docs/plans/maintenance-productization.md.
 *
 * @module maintenance/context
 */

import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_MARKER_NAMESPACE } from '@cycgraph/tools/git';
import { APPROVED_LABEL, CHANGESET_INSTRUCTION, DEFAULT_BASE_BRANCH, DEFAULT_WORKSPACE_ROOTS, MANAGED_LABEL, NEEDS_HUMAN_LABEL, STANDARDS_BRIEF } from './repo.js';

/** The issue and PR labels the maintenance loop reads, writes, and filters on. */
export interface MaintenanceLabels {
  /** Approves an issue or ticket for the automated fix queue. */
  approved: string;
  /** Marks a PR the loop may push to. */
  managed: string;
  /** Marks work the loop has handed back for a human decision. */
  needsHuman: string;
}

/** Who the maintenance loop commits and pushes as. */
export interface MaintenanceIdentity {
  name: string;
  email: string;
}

/** The repository-shaped settings the maintenance workflows read. */
export interface MaintenanceContext {
  /**
   * The labels the loop reads, applies, and filters on. Renaming one here
   * is not sufficient on its own: the same literals gate the
   * `.github/workflows/*.yml` event filters, which run before any code
   * this context reaches, so the two must be changed together.
   */
  labels: MaintenanceLabels;
  /**
   * House coding standards, distilled for editing and reviewing agent
   * prompts. The target repository's own convention document is the
   * authority; this is the short form an agent most often breaks without.
   */
  standardsBrief: string;
  /**
   * A convention document in the target tree to treat as the authority,
   * as a repo-relative path. When set, a tool-having agent is pointed at
   * it to read with its own tools; when unset, {@link resolveStandardsBrief}
   * probes {@link DEFAULT_STANDARDS_DOCS} and uses the first that exists.
   * The document is never pasted into a prompt — it is semi-trusted text
   * from the target repository, so it reaches the agent only through the
   * read tool, never the instruction channel.
   */
  standardsDoc?: string;
  /**
   * Release-note discipline for agents that edit published-package
   * source, shared verbatim so the convention cannot drift between
   * prompts.
   */
  changesetInstruction: string;
  /**
   * Top-level directories {@link repoMap} treats as workspace roots when
   * summarizing the tree. A flat or differently-organized repository
   * supplies its own.
   */
  workspaceRoots: readonly string[];
  /**
   * Prepended to every branch the loop creates, so all maintenance
   * branches can share a namespace a repository's branch protection and
   * cleanup rules target. Includes its own trailing separator; the
   * default is empty, which leaves branch names as they are.
   */
  branchPrefix: string;
  /**
   * The branch pull requests target and staleness is measured against.
   */
  defaultBranch: string;
  /**
   * The namespace on the finding markers the loop writes into issue
   * bodies and reads back. A wire format on live issues: renaming it
   * orphans every marker already filed, so it is a one-time choice per
   * repository, not a per-run knob.
   */
  markerNamespace: string;
  /**
   * Whether the workflows run the target repository's checks locally in
   * the workspace — the agent's `run_check`, the `repo_checks` gate's
   * commands, and an implemented ticket's runnable acceptance criteria.
   *
   * Customer-zero runs a tight local loop on the single trusted
   * repository it lives in, so this defaults to `true`. The product sets
   * it `false`: the target repository already runs its own checks in its
   * own CI, with the secrets and services a full suite needs, which the
   * maintenance sandbox cannot and must not reconstruct. With it off, no
   * tree code runs locally — the run pushes and treats the repository's CI
   * as the authoritative gate, and `pr-ci-failure.yml` feeds a failing CI
   * back to pr-revise. The tree-mutation guard in `repo_checks` still runs
   * (it is a git diff, not tree code).
   */
  runLocalChecks: boolean;
  /**
   * The commit identity the loop authors as, when the environment supplies
   * none through `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`. Absent leaves the
   * environment as the only source, which is this repository's default.
   */
  identity?: MaintenanceIdentity;
}

/**
 * This repository's own context. The value every workflow uses unless a
 * run supplies its own, so a maintenance run of `mc-ai-orchestrator`
 * behaves identically whether or not a context was passed.
 */
export function defaultMaintenanceContext(): MaintenanceContext {
  return {
    labels: { approved: APPROVED_LABEL, managed: MANAGED_LABEL, needsHuman: NEEDS_HUMAN_LABEL },
    standardsBrief: STANDARDS_BRIEF,
    changesetInstruction: CHANGESET_INSTRUCTION,
    workspaceRoots: DEFAULT_WORKSPACE_ROOTS,
    branchPrefix: '',
    defaultBranch: DEFAULT_BASE_BRANCH,
    markerNamespace: DEFAULT_MARKER_NAMESPACE,
    runLocalChecks: true,
  };
}

/**
 * The context a run carries, or this repository's default when it carries
 * none. The one place a build resolves its context, so every consumer
 * reads the same resolved value.
 */
export function contextOf(env: { context?: MaintenanceContext }): MaintenanceContext {
  return env.context ?? defaultMaintenanceContext();
}

/**
 * A branch name under the context's namespace. Every branch the loop
 * creates passes through here, so a non-empty `branchPrefix` gathers all
 * maintenance branches under one prefix; the default empty prefix leaves
 * the name unchanged.
 */
export function maintenanceBranch(ctx: MaintenanceContext, name: string): string {
  return `${ctx.branchPrefix}${name}`;
}

/**
 * Convention documents probed, in order, when a context names no
 * `standardsDoc`. The first that exists in the target tree is the one an
 * agent is pointed at, so most repositories need no configuration.
 */
export const DEFAULT_STANDARDS_DOCS: readonly string[] = [
  '.claude/CLAUDE.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
];

/**
 * The repo-relative convention document to point an agent at, or
 * undefined when none applies. An explicit `standardsDoc` is honored
 * alone (a missing one yields undefined rather than falling through to
 * the defaults); otherwise the default candidates are tried in order.
 * Paths that are absolute or escape the root are refused.
 */
async function findStandardsDoc(repoRoot: string, ctx: MaintenanceContext): Promise<string | undefined> {
  const candidates = ctx.standardsDoc !== undefined ? [ctx.standardsDoc] : DEFAULT_STANDARDS_DOCS;
  for (const rel of candidates) {
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
    try {
      await access(join(repoRoot, rel));
      return rel;
    } catch {
      // Absent; try the next candidate.
    }
  }
  return undefined;
}

/**
 * The standards brief a tool-having agent receives: the context's own
 * `standardsBrief`, plus a pointer to the target repository's convention
 * document when one exists. The document's bytes are never inlined; the
 * agent is told to read it with its own tools and treat it as the
 * authority, which keeps semi-trusted repository text out of the
 * instruction channel. A toolless agent cannot act on the pointer, so it
 * is given `ctx.standardsBrief` directly rather than this.
 */
export async function resolveStandardsBrief(repoRoot: string, ctx: MaintenanceContext): Promise<string> {
  const doc = await findStandardsDoc(repoRoot, ctx);
  if (doc === undefined) return ctx.standardsBrief;
  return `${ctx.standardsBrief} This repository's own conventions are in \`${doc}\`; read it with read_file and treat it as the authority wherever it is more specific than the rules above.`;
}
