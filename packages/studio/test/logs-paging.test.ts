/**
 * Tests for the cross-run paging cutoff: runs overlap in time, so the scan
 * may only skip a run that provably ended below the page's floor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryLogs } from '../src/server/logs.js';

let root: string;

async function writeRun(options: {
  runId: string;
  startedAt: string;
  endedAt?: string;
  timestamps: string[];
}): Promise<void> {
  const dir = join(root, 'runs', `flow-${options.runId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    runId: options.runId,
    scenarioId: 'flow',
    params: {},
    stack: {},
    startedAt: options.startedAt,
    ...(options.endedAt ? { endedAt: options.endedAt } : {}),
    status: 'completed',
  }));
  await writeFile(join(dir, 'usage.json'), JSON.stringify({ totalTokens: 0, totalCostUsd: 0, nodesVisited: 1 }));
  await writeFile(join(dir, 'evals.json'), '[]');
  await writeFile(join(dir, 'logs.ndjson'), options.timestamps
    .map((timestamp) => JSON.stringify({
      timestamp,
      level: 'info',
      event: 'node.started',
      context: { node_id: 'research' },
    }))
    .join('\n'));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-logpage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('queryLogs paging cutoff', () => {
  it('includes newer rows from an older-starting run that outlived the page floor', async () => {
    await writeRun({
      runId: '11111111-1111-1111-1111-111111111111',
      startedAt: '2026-08-21T00:10:00.000Z',
      endedAt: '2026-08-21T00:11:00.000Z',
      timestamps: [
        '2026-08-21T00:10:01.000Z',
        '2026-08-21T00:10:02.000Z',
        '2026-08-21T00:10:03.000Z',
      ],
    });
    await writeRun({
      runId: '22222222-2222-2222-2222-222222222222',
      startedAt: '2026-08-21T00:00:00.000Z',
      endedAt: '2026-08-21T00:20:00.000Z',
      timestamps: ['2026-08-21T00:19:00.000Z'],
    });

    const { rows, runsScanned } = await queryLogs(root, { limit: 2 });

    expect(rows.map((row) => row.at)).toEqual([
      '2026-08-21T00:19:00.000Z',
      '2026-08-21T00:10:03.000Z',
    ]);
    expect(runsScanned).toBe(2);
  });

  it('skips a run that ended below the page floor', async () => {
    await writeRun({
      runId: '11111111-1111-1111-1111-111111111111',
      startedAt: '2026-08-21T00:10:00.000Z',
      endedAt: '2026-08-21T00:11:00.000Z',
      timestamps: [
        '2026-08-21T00:10:01.000Z',
        '2026-08-21T00:10:02.000Z',
      ],
    });
    await writeRun({
      runId: '22222222-2222-2222-2222-222222222222',
      startedAt: '2026-08-21T00:00:00.000Z',
      endedAt: '2026-08-21T00:01:00.000Z',
      timestamps: ['2026-08-21T00:00:30.000Z'],
    });

    const { rows, runsScanned } = await queryLogs(root, { limit: 2 });

    expect(rows.map((row) => row.at)).toEqual([
      '2026-08-21T00:10:02.000Z',
      '2026-08-21T00:10:01.000Z',
    ]);
    expect(runsScanned).toBe(1);
  });

  it('scans a run with no recorded end even below the page floor', async () => {
    await writeRun({
      runId: '11111111-1111-1111-1111-111111111111',
      startedAt: '2026-08-21T00:10:00.000Z',
      endedAt: '2026-08-21T00:11:00.000Z',
      timestamps: [
        '2026-08-21T00:10:01.000Z',
        '2026-08-21T00:10:02.000Z',
      ],
    });
    await writeRun({
      runId: '22222222-2222-2222-2222-222222222222',
      startedAt: '2026-08-21T00:00:00.000Z',
      timestamps: ['2026-08-21T00:30:00.000Z'],
    });

    const { rows, runsScanned } = await queryLogs(root, { limit: 2 });

    expect(rows.map((row) => row.at)).toEqual([
      '2026-08-21T00:30:00.000Z',
      '2026-08-21T00:10:02.000Z',
    ]);
    expect(runsScanned).toBe(2);
  });
});
