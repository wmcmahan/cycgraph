/** Tests for workspace layout resolution (src/improve/layout.ts). */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { rebaseSource, scenarioModulePath, typecheckDir } from '../src/improve/layout.js';

describe('rebaseSource', () => {
  it('rebases a host checkout path to a repo-relative one', () => {
    const rebased = rebaseSource('/host/repo', '/host/repo/apps/flows/checkout.ts');

    expect(rebased).toBe(join('apps', 'flows', 'checkout.ts'));
  });

  it('yields nothing for a path outside the repository', () => {
    const rebased = rebaseSource('/host/repo', '/elsewhere/checkout.ts');

    expect(rebased).toBe(undefined);
  });
});

describe('scenarioModulePath', () => {
  it('imports the declared source file from inside the clone', () => {
    const path = scenarioModulePath('/ws', 'checkout', join('apps', 'flows', 'checkout.ts'));

    expect(path).toBe(join('/ws', 'apps', 'flows', 'checkout.ts'));
  });

  it('falls back to the internal playground layout with no source path', () => {
    const path = scenarioModulePath('/ws', 'checkout');

    expect(path).toBe(join('/ws', 'packages', 'playground', 'src', 'scenarios', 'checkout', 'scenario.ts'));
  });
});

describe('typecheckDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cycgraph-layout-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs in the TypeScript project the edited file belongs to', async () => {
    const project = join(root, 'apps', 'flows');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'tsconfig.json'), '{}');

    const dir = typecheckDir(root, join('apps', 'flows', 'src', 'checkout.ts'));

    expect(dir).toBe(project);
  });

  it('runs in the edited file directory when no project encloses it', async () => {
    await mkdir(join(root, 'apps', 'flows'), { recursive: true });

    const dir = typecheckDir(root, join('apps', 'flows', 'checkout.ts'));

    expect(dir).toBe(join(root, 'apps', 'flows'));
  });

  it('falls back to the internal playground with no source path', () => {
    const dir = typecheckDir(root);

    expect(dir).toBe(join(root, 'packages', 'playground'));
  });
});
