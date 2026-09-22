/**
 * Tests for the maintenance context (src/shared/context.ts) — the seam
 * that carries repository-shaped settings, defaulted to this repository.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { contextOf, defaultMaintenanceContext, maintenanceBranch, resolveStandardsBrief, type MaintenanceContext } from '../src/shared/context.js';
import { APPROVED_LABEL, CHANGESET_INSTRUCTION, DEFAULT_BASE_BRANCH, DEFAULT_WORKSPACE_ROOTS, MANAGED_LABEL, NEEDS_HUMAN_LABEL, STANDARDS_BRIEF } from '../src/shared/repo.js';
import { DEFAULT_MARKER_NAMESPACE } from '@cycgraph/tools/git';

const roots: string[] = [];

async function seedTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cycgraph-context-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

const pointerTo = (doc: string): string =>
  `${STANDARDS_BRIEF} This repository's own conventions are in \`${doc}\`; read it with read_file and treat it as the authority wherever it is more specific than the rules above.`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('defaultMaintenanceContext', () => {
  it('carries this repository\'s labels, standards, changeset discipline, and workspace roots', () => {
    expect(defaultMaintenanceContext()).toEqual({
      labels: { approved: APPROVED_LABEL, managed: MANAGED_LABEL, needsHuman: NEEDS_HUMAN_LABEL },
      standardsBrief: STANDARDS_BRIEF,
      changesetInstruction: CHANGESET_INSTRUCTION,
      workspaceRoots: DEFAULT_WORKSPACE_ROOTS,
      branchPrefix: '',
      defaultBranch: DEFAULT_BASE_BRANCH,
      markerNamespace: DEFAULT_MARKER_NAMESPACE,
      runLocalChecks: true,
    });
  });
});

describe('contextOf', () => {
  it('returns the supplied context unchanged when a run carries one', () => {
    const supplied: MaintenanceContext = {
      labels: { approved: 'ready', managed: 'bot-pr', needsHuman: 'blocked' },
      standardsBrief: 'their standards',
      changesetInstruction: 'their release note rule',
      workspaceRoots: ['services'],
      branchPrefix: 'bot/',
      defaultBranch: 'trunk',
      markerNamespace: 'acme:finding',
      runLocalChecks: false,
    };

    expect(contextOf({ context: supplied })).toBe(supplied);
  });

  it('falls back to this repository\'s default when a run carries none', () => {
    expect(contextOf({})).toEqual(defaultMaintenanceContext());
  });
});

describe('maintenanceBranch', () => {
  it('leaves the name unchanged under the default empty prefix', () => {
    expect(maintenanceBranch(defaultMaintenanceContext(), 'upkeep/fix-abcd1234')).toBe('upkeep/fix-abcd1234');
  });

  it('gathers the branch under a non-empty prefix', () => {
    const ctx: MaintenanceContext = { ...defaultMaintenanceContext(), branchPrefix: 'bot/' };

    expect(maintenanceBranch(ctx, 'upkeep/fix-abcd1234')).toBe('bot/upkeep/fix-abcd1234');
  });
});

describe('resolveStandardsBrief', () => {
  it('appends a pointer to the convention document that exists in the tree', async () => {
    const root = await seedTree({ 'CLAUDE.md': '# rules\n' });

    const brief = await resolveStandardsBrief(root, defaultMaintenanceContext());

    expect(brief).toBe(pointerTo('CLAUDE.md'));
  });

  it('returns the base brief unchanged when no convention document exists', async () => {
    const root = await seedTree({ 'README.md': '# repo\n' });

    const brief = await resolveStandardsBrief(root, defaultMaintenanceContext());

    expect(brief).toBe(STANDARDS_BRIEF);
  });

  it('prefers the earlier default candidate when several exist', async () => {
    const root = await seedTree({ '.claude/CLAUDE.md': '# rules\n', 'CLAUDE.md': '# other\n', 'AGENTS.md': '# more\n' });

    const brief = await resolveStandardsBrief(root, defaultMaintenanceContext());

    expect(brief).toBe(pointerTo('.claude/CLAUDE.md'));
  });

  it('points at an explicit standardsDoc over the default candidates', async () => {
    const root = await seedTree({ 'CLAUDE.md': '# ignored\n', 'docs/STYLE.md': '# house\n' });
    const ctx: MaintenanceContext = { ...defaultMaintenanceContext(), standardsDoc: 'docs/STYLE.md' };

    const brief = await resolveStandardsBrief(root, ctx);

    expect(brief).toBe(pointerTo('docs/STYLE.md'));
  });

  it('does not fall through to the defaults when an explicit standardsDoc is missing', async () => {
    const root = await seedTree({ 'CLAUDE.md': '# present\n' });
    const ctx: MaintenanceContext = { ...defaultMaintenanceContext(), standardsDoc: 'STYLE.md' };

    const brief = await resolveStandardsBrief(root, ctx);

    expect(brief).toBe(STANDARDS_BRIEF);
  });

  it('refuses a standardsDoc that escapes the repository root', async () => {
    const root = await seedTree({ 'CLAUDE.md': '# present\n' });
    const ctx: MaintenanceContext = { ...defaultMaintenanceContext(), standardsDoc: '../CLAUDE.md' };

    const brief = await resolveStandardsBrief(root, ctx);

    expect(brief).toBe(STANDARDS_BRIEF);
  });
});
