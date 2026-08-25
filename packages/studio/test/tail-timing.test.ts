/**
 * Tests for loadNodeTiming and loadTailMs (src/run/history.ts), which read
 * execution time out of a recorded run's event stream.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNodeTiming, loadTailMs } from '../src/run/history.js';

let dir: string;

interface Completion {
  node_id: string;
  node_type?: string;
  duration_ms?: number;
}

async function record(...completions: Completion[]): Promise<void> {
  const lines = completions.map((completion) =>
    JSON.stringify({ type: 'node:complete', timestamp: 1, ...completion }));
  await writeFile(join(dir, 'events.ndjson'), `${lines.join('\n')}\n`, 'utf8');
}

async function recordRaw(contents: string): Promise<void> {
  await writeFile(join(dir, 'events.ndjson'), contents, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cycgraph-timing-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadNodeTiming', () => {
  it('sums the time a node spent across its visits', async () => {
    await record(
      { node_id: 'boss', node_type: 'supervisor', duration_ms: 1000 },
      { node_id: 'boss', node_type: 'supervisor', duration_ms: 1500 },
    );

    const timing = await loadNodeTiming(dir);

    expect(timing['boss']).toEqual({ type: 'supervisor', total_ms: 2500, visits: 2 });
  });

  it('carries the node type the engine stamped', async () => {
    await record({ node_id: 'gate', node_type: 'approval', duration_ms: 1 });

    const timing = await loadNodeTiming(dir);

    expect(timing['gate']!.type).toBe('approval');
  });

  it('counts a visit that recorded no duration', async () => {
    await record({ node_id: 'boss', node_type: 'supervisor' });

    const timing = await loadNodeTiming(dir);

    expect(timing['boss']).toEqual({ type: 'supervisor', total_ms: 0, visits: 1 });
  });

  it('ignores events that are not node completions', async () => {
    await recordRaw([
      JSON.stringify({ type: 'agent:token_delta', node_id: 'boss', duration_ms: 9999 }),
      JSON.stringify({ type: 'node:complete', node_id: 'boss', duration_ms: 5 }),
    ].join('\n'));

    const timing = await loadNodeTiming(dir);

    expect(timing['boss']!.total_ms).toBe(5);
  });

  it('tolerates a truncated final line from a killed run', async () => {
    await recordRaw([
      JSON.stringify({ type: 'node:complete', node_id: 'boss', duration_ms: 5 }),
      '{"type":"node:complete","node_id":"dr',
    ].join('\n'));

    const timing = await loadNodeTiming(dir);

    expect(Object.keys(timing)).toEqual(['boss']);
  });

  it('returns nothing for a run that recorded no events', async () => {
    expect(await loadNodeTiming(dir)).toEqual({});
  });
});

describe('loadTailMs', () => {
  it('sums from the named node to the end of the run', async () => {
    await record(
      { node_id: 'seed', duration_ms: 100 },
      { node_id: 'boss', duration_ms: 1000 },
      { node_id: 'worker', duration_ms: 500 },
    );

    expect(await loadTailMs(dir, 'boss')).toBe(1500);
  });

  it('excludes everything before the node', async () => {
    await record(
      { node_id: 'seed', duration_ms: 9000 },
      { node_id: 'boss', duration_ms: 10 },
    );

    expect(await loadTailMs(dir, 'boss')).toBe(10);
  });

  it('counts every later visit of a node visited repeatedly', async () => {
    await record(
      { node_id: 'boss', duration_ms: 100 },
      { node_id: 'worker', duration_ms: 50 },
      { node_id: 'boss', duration_ms: 200 },
    );

    expect(await loadTailMs(dir, 'boss')).toBe(350);
  });

  it('covers the whole run when the node started it', async () => {
    await record(
      { node_id: 'boss', duration_ms: 100 },
      { node_id: 'worker', duration_ms: 50 },
    );

    expect(await loadTailMs(dir, 'boss')).toBe(150);
  });

  it('returns nothing for a node the run never reached', async () => {
    await record({ node_id: 'boss', duration_ms: 100 });

    expect(await loadTailMs(dir, 'ghost')).toBeUndefined();
  });

  it('returns nothing when there are no events to read', async () => {
    expect(await loadTailMs(dir, 'boss')).toBeUndefined();
  });
});
