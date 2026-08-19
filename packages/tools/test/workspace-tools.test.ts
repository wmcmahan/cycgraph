/**
 * Tests for the workspace tool set (src/workspace/): the jail, the
 * unique-match edit, and the search surface an editor agent gets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkspaceSession,
  diagnosticsTool,
  editFileTool,
  jailedPath,
  readFileTool,
  searchTool,
  workspaceTools,
  WorkspaceEscapeError,
} from '../src/workspace/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-wstools-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'src', 'config.ts'), 'export const maxIterations = 6;\nexport const other = 1;\n');
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'maxIterations everywhere\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('jailedPath', () => {
  it('resolves a relative path under the root', () => {
    expect(jailedPath(root, 'src/config.ts')).toBe(join(root, 'src', 'config.ts'));
  });

  it('refuses a parent traversal', () => {
    expect(() => jailedPath(root, '../outside')).toThrow(WorkspaceEscapeError);
  });

  it('refuses an absolute path outside the root', () => {
    expect(() => jailedPath(root, '/etc/hosts')).toThrow(WorkspaceEscapeError);
  });

  it('allows a dotted path that stays inside', () => {
    expect(jailedPath(root, 'src/../src/config.ts')).toBe(join(root, 'src', 'config.ts'));
  });
});

describe('readFileTool', () => {
  it('reads a file by workspace-relative path', async () => {
    const result = await readFileTool({ root }).execute({ path: 'src/config.ts' });

    expect(result).toContain('maxIterations = 6');
  });

  it('refuses a file above the byte cap as not source', async () => {
    const result = await readFileTool({ root, maxFileBytes: 10 }).execute({ path: 'src/config.ts' });

    expect(result).toContain('not editable source');
  });

  it('windows a long file and says how to read on', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(root, 'src', 'long.ts'), long);

    const result = await readFileTool({ root, defaultLimit: 4 }).execute({ path: 'src/long.ts' });

    expect(result).toContain('[lines 1-4 of 10 — call again with offset=5 for the rest]');
    expect(result).toContain('line 4');
    expect(result).not.toContain('line 5');
  });

  it('reads a later window by offset', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(root, 'src', 'long.ts'), long);

    const result = await readFileTool({ root }).execute({ path: 'src/long.ts', offset: 9, limit: 5 });

    expect(result).toContain('[lines 9-10 of 10]');
    expect(result).toContain('line 10');
  });

  it('refuses an offset past the end of the file', async () => {
    const result = await readFileTool({ root }).execute({ path: 'src/config.ts', offset: 99 });

    expect(result).toContain('offset 99 is past the end');
  });

  it('returns a short file whole, without a window marker', async () => {
    const result = await readFileTool({ root }).execute({ path: 'src/config.ts' });

    expect(result).not.toContain('[lines');
  });

  it('is declared tainting, because workspace contents are external', () => {
    expect(readFileTool({ root }).taints).toBe(true);
  });
});

describe('searchTool', () => {
  it('finds files containing the query with their matching lines', async () => {
    const result = await searchTool({ root }).execute({ query: 'maxIterations' });

    expect(result).toContain('src/config.ts');
    expect(result).toContain('1: export const maxIterations = 6;');
  });

  it('never descends into dependency directories', async () => {
    const result = await searchTool({ root }).execute({ query: 'maxIterations' });

    expect(result).not.toContain('node_modules');
  });

  it('caps the files it reports', async () => {
    await writeFile(join(root, 'src', 'a.ts'), 'needle\n');
    await writeFile(join(root, 'src', 'b.ts'), 'needle\n');

    const result = await searchTool({ root, maxHits: 1 }).execute({ query: 'needle' });

    expect(String(result).split('\n\n')).toHaveLength(1);
  });

  it('says plainly when nothing matches', async () => {
    expect(await searchTool({ root }).execute({ query: 'nowhere-at-all' }))
      .toBe("no file contains 'nowhere-at-all'");
  });
});

describe('editFileTool', () => {
  it('applies a unique exact replacement', async () => {
    const result = await editFileTool({ root }).execute({
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    expect(result).toBe("edited 'src/config.ts'");
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 3');
  });

  it('refuses a find that does not appear, changing nothing', async () => {
    const result = await editFileTool({ root }).execute({
      path: 'src/config.ts', find: 'absent', replace: 'x',
    });

    expect(result).toContain('does not appear');
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 6');
  });

  it('refuses an ambiguous find, changing nothing', async () => {
    const result = await editFileTool({ root }).execute({
      path: 'src/config.ts', find: 'export const', replace: 'x',
    });

    expect(result).toContain('more than once');
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 6');
  });
});

describe('edit_file with a session', () => {
  it('refuses to edit a file that was never read', async () => {
    const session = createWorkspaceSession();

    const result = await editFileTool({ root, session }).execute({
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    expect(result).toBe("error: read 'src/config.ts' before editing it");
  });

  it('edits after a read of the same content', async () => {
    const session = createWorkspaceSession();
    await readFileTool({ root, session }).execute({ path: 'src/config.ts' });

    const result = await editFileTool({ root, session }).execute({
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    expect(result).toBe("edited 'src/config.ts'");
  });

  it('refuses a file that changed since it was read', async () => {
    const session = createWorkspaceSession();
    await readFileTool({ root, session }).execute({ path: 'src/config.ts' });
    await writeFile(join(root, 'src', 'config.ts'), 'export const maxIterations = 6; // drifted\n');

    const result = await editFileTool({ root, session }).execute({
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    expect(result).toContain('changed since it was read');
  });

  it('lets an agent keep editing its own work without re-reading', async () => {
    const session = createWorkspaceSession();
    await readFileTool({ root, session }).execute({ path: 'src/config.ts' });
    await editFileTool({ root, session }).execute({
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    const second = await editFileTool({ root, session }).execute({
      path: 'src/config.ts', find: 'other = 1', replace: 'other = 2',
    });

    expect(second).toBe("edited 'src/config.ts'");
  });
});

describe('diagnosticsTool', () => {
  it('reports clean when the configured check exits zero', async () => {
    const result = await diagnosticsTool({
      cwd: root, command: 'node', args: ['-e', 'process.exit(0)'],
    }).execute({});

    expect(result).toEqual({ clean: true, output: 'no diagnostics' });
  });

  it('returns the check output when it fails', async () => {
    const result = await diagnosticsTool({
      cwd: root, command: 'node', args: ['-e', 'console.error("src/config.ts(1,1): boom"); process.exit(1)'],
    }).execute({}) as { clean: boolean; output: string };

    expect(result.clean).toBe(false);
    expect(result.output).toContain('boom');
  });

  it('truncates a flood of findings to the line cap', async () => {
    const result = await diagnosticsTool({
      cwd: root, command: 'node', maxLines: 3,
      args: ['-e', 'for (let i = 0; i < 10; i++) console.error("finding " + i); process.exit(1)'],
    }).execute({}) as { output: string };

    expect(result.output).toContain('[7 more line(s) truncated]');
  });
});

describe('workspaceTools', () => {
  it('bundles the full editor surface over one root', () => {
    expect(workspaceTools(root).map(tool => tool.name)).toEqual(['search', 'read_file', 'edit_file']);
  });

  it('arms the read-before-edit discipline across the bundle', async () => {
    const [, read, edit] = workspaceTools(root);

    const refused = await edit!.execute({ path: 'src/config.ts', find: 'maxIterations = 6', replace: 'x' });
    expect(refused).toContain('before editing it');

    await read!.execute({ path: 'src/config.ts' });
    const allowed = await edit!.execute({ path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3' });
    expect(allowed).toBe("edited 'src/config.ts'");
  });
});
