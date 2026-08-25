/**
 * Tests for the workspace MCP server (src/run/workspace-server.ts): the jail,
 * the unique-match edit, and the search surface an editor agent gets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorkspaceServer } from '../src/improve/workspace-server.js';
import type { WorkspaceServer } from '../src/improve/workspace-server.js';

let root: string;
let server: WorkspaceServer;

async function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = await response.text();
  const line = body.split('\n').find(l => l.startsWith('data:')) ?? body;
  const parsed = JSON.parse(line.replace(/^data:\s*/, '')) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  if (parsed.error) return `rpc error: ${parsed.error.message}`;
  return parsed.result?.content?.[0]?.text ?? '';
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-wsrv-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'config.ts'), 'export const maxIterations = 6;\nexport const other = 1;\n');
  await writeFile(join(root, 'README.md'), 'nothing here\n');
  server = await startWorkspaceServer(root);
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('read_file', () => {
  it('reads a file by workspace-relative path', async () => {
    expect(await call('read_file', { path: 'src/config.ts' })).toContain('maxIterations = 6');
  });

  it('refuses a path that escapes the workspace', async () => {
    const result = await call('read_file', { path: '../outside.txt' });

    expect(result).toContain('escapes the workspace');
  });

  it('refuses an absolute path outside the workspace', async () => {
    const result = await call('read_file', { path: '/etc/hosts' });

    expect(result).toContain('escapes the workspace');
  });
});

describe('search', () => {
  it('finds files containing the query with their matching lines', async () => {
    const result = await call('search', { query: 'maxIterations' });

    expect(result).toContain('src/config.ts');
    expect(result).toContain('1: export const maxIterations = 6;');
  });

  it('says plainly when nothing matches', async () => {
    expect(await call('search', { query: 'nowhere-at-all' })).toContain("no file contains");
  });
});

describe('edit_file', () => {
  it('applies a unique exact replacement', async () => {
    const result = await call('edit_file', {
      path: 'src/config.ts', find: 'maxIterations = 6', replace: 'maxIterations = 3',
    });

    expect(result).toBe("edited 'src/config.ts'");
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 3');
  });

  it('refuses a find that does not appear, changing nothing', async () => {
    const result = await call('edit_file', { path: 'src/config.ts', find: 'absent', replace: 'x' });

    expect(result).toContain('does not appear');
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 6');
  });

  it('refuses an ambiguous find, changing nothing', async () => {
    const result = await call('edit_file', { path: 'src/config.ts', find: 'export const', replace: 'x' });

    expect(result).toContain('more than once');
    expect(await readFile(join(root, 'src', 'config.ts'), 'utf8')).toContain('maxIterations = 6');
  });

  it('refuses to edit outside the workspace', async () => {
    const result = await call('edit_file', { path: '../anything', find: 'a', replace: 'b' });

    expect(result).toContain('escapes the workspace');
  });
});
