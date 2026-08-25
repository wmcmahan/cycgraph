/**
 * Tests for the log row's structured fields: the columns the stream shows
 * come from named fields, not from a generic key=value blob.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryLogs } from '../src/server/logs.js';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-logcols-'));
  dir = join(root, 'runs', 'flow-11111111-2222-3333-4444-555555555555');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    runId: '11111111-2222-3333-4444-555555555555',
    scenarioId: 'flow',
    params: {},
    stack: {},
    startedAt: '2026-08-21T00:00:00.000Z',
    status: 'completed',
  }));
  await writeFile(join(dir, 'usage.json'), JSON.stringify({ totalTokens: 0, totalCostUsd: 0, nodesVisited: 1 }));
  await writeFile(join(dir, 'evals.json'), '[]');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('queryLogs row fields', () => {
  it('promotes duration, tool, agent, and model out of the context blob', async () => {
    await writeFile(join(dir, 'logs.ndjson'), `${JSON.stringify({
      timestamp: '2026-08-21T00:00:01.000Z',
      level: 'info',
      event: 'agent.executor.tool_called',
      context: {
        run_id: 'r', graph_id: 'g', node_id: 'research',
        tool_name: 'search', agent_id: 'researcher', model: 'qwen2.5:7b',
        duration_ms: 42, attempt: 2,
      },
    })}\n`);

    const { rows } = await queryLogs(root, { kinds: ['log'] });

    expect(rows[0]).toMatchObject({
      node: 'research',
      tool: 'search',
      agent: 'researcher',
      model: 'qwen2.5:7b',
      durationMs: 42,
    });
  });

  it('leaves only unclaimed context in detail', async () => {
    await writeFile(join(dir, 'logs.ndjson'), `${JSON.stringify({
      timestamp: '2026-08-21T00:00:01.000Z',
      level: 'info',
      event: 'agent.executor.tool_called',
      context: { node_id: 'research', tool_name: 'search', duration_ms: 42, attempt: 2 },
    })}\n`);

    const { rows } = await queryLogs(root, { kinds: ['log'] });

    expect(rows[0]!.detail).toBe('attempt=2');
  });

  it('gives a failed node event its error as the detail', async () => {
    await writeFile(join(dir, 'events.ndjson'), `${JSON.stringify({
      type: 'node:failed',
      node_id: 'research',
      timestamp: Date.parse('2026-08-21T00:00:02.000Z'),
      duration_ms: 7,
      error: 'the model refused',
    })}\n`);

    const { rows } = await queryLogs(root, { kinds: ['event'] });

    expect(rows[0]).toMatchObject({ node: 'research', durationMs: 7, detail: 'the model refused' });
  });

  it('matches free text against a named field, not just the event name', async () => {
    await writeFile(join(dir, 'logs.ndjson'), `${JSON.stringify({
      timestamp: '2026-08-21T00:00:01.000Z',
      level: 'info',
      event: 'agent.executor.tool_called',
      context: { node_id: 'research', tool_name: 'web_search' },
    })}\n`);

    const { rows } = await queryLogs(root, { q: 'web_search' });

    expect(rows).toHaveLength(1);
  });
});
