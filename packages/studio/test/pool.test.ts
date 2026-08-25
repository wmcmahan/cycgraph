/**
 * Tests for findReusableDraws (src/run/pool.ts), which serves recorded forks
 * as draws so identical arms are not re-run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findReusableDraws } from '../src/improve/pool.js';
import type { DrawKey } from '../src/improve/pool.js';

const BASE = 'base-run';
const MODEL = 'qwen2.5:7b';
const TEMPERATURE = { kind: 'temperature', target: 'boss', temperature: 0.35 };

let root: string;
let counter = 0;

interface ForkFixture {
  parent?: string;
  sequence?: number;
  changes?: unknown[];
  memoized?: boolean;
  model?: string;
  passed?: boolean;
  ms?: number;
  startedAt?: string;
}

async function recordFork(fixture: ForkFixture = {}): Promise<string> {
  const runId = `fork-${counter}`;
  const dir = join(root, 'runs', `wf-${counter++}`);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    runId,
    scenarioId: 'wf',
    params: {},
    stack: { model: fixture.model ?? MODEL },
    startedAt: fixture.startedAt ?? `2026-08-18T00:00:${String(counter).padStart(2, '0')}.000Z`,
    status: 'completed',
    parentRunId: fixture.parent ?? BASE,
    forkSequenceId: fixture.sequence ?? 7,
    forkChanges: fixture.changes ?? [TEMPERATURE],
    forkMemoized: fixture.memoized ?? false,
  }));

  await writeFile(join(dir, 'evals.json'), JSON.stringify([
    { assertion: { type: 'status_equals' }, passed: fixture.passed ?? true },
  ]));

  await writeFile(join(dir, 'events.ndjson'), JSON.stringify({
    type: 'node:complete', node_id: 'boss', node_type: 'supervisor',
    duration_ms: fixture.ms ?? 1000, timestamp: 1,
  }) + '\n');

  return runId;
}

function key(partial: Partial<DrawKey> = {}): DrawKey {
  return {
    baseRunId: BASE,
    forkSequenceId: 7,
    changes: [TEMPERATURE] as never,
    model: MODEL,
    ...partial,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-pool-'));
  counter = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findReusableDraws', () => {
  it('serves a recorded fork whose key matches', async () => {
    await recordFork({ ms: 1234 });

    const draws = await findReusableDraws(root, 'wf', key(), 'temperature=0.35', 5, new Set());

    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ name: 'temperature=0.35', computeMs: 1234, reused: true });
  });

  it('carries the recorded verdict through', async () => {
    await recordFork({ passed: false });

    const draws = await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set());

    expect(draws[0]).toMatchObject({ assertionsHeld: false, failed: ['status_equals'] });
  });

  it('serves at most the draws needed', async () => {
    await recordFork();
    await recordFork();
    await recordFork();

    const draws = await findReusableDraws(root, 'wf', key(), 'arm', 2, new Set());

    expect(draws).toHaveLength(2);
  });

  it('never serves the same recorded draw twice in one pass', async () => {
    await recordFork();
    const consumed = new Set<string>();

    const first = await findReusableDraws(root, 'wf', key(), 'arm', 5, consumed);
    const second = await findReusableDraws(root, 'wf', key(), 'arm', 5, consumed);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('matches changes structurally rather than by construction', async () => {
    await recordFork({ changes: [{ target: 'boss', kind: 'temperature', temperature: 0.35 }] });

    const draws = await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set());

    expect(draws).toHaveLength(1);
  });

  it('excludes a fork of a different base run', async () => {
    await recordFork({ parent: 'other-base' });

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a fork taken at a different point', async () => {
    await recordFork({ sequence: 13 });

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a fork with different changes', async () => {
    await recordFork({ changes: [{ kind: 'temperature', target: 'boss', temperature: 0 }] });

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a fork made against a different model', async () => {
    await recordFork({ model: 'gemma2:9b' });

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a memoized fork, whose timings measure the recording', async () => {
    await recordFork({ memoized: true });

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a fork recorded before the memoized flag existed', async () => {
    const runId = await recordFork();
    const dir = join(root, 'runs', 'wf-0');
    const meta = {
      runId, scenarioId: 'wf', params: {}, stack: { model: MODEL },
      startedAt: '2026-08-18T00:00:00.000Z', status: 'completed',
      parentRunId: BASE, forkSequenceId: 7, forkChanges: [TEMPERATURE],
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('excludes a fork that checked no assertions', async () => {
    await recordFork();
    await writeFile(join(root, 'runs', 'wf-0', 'evals.json'), '[]');

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 5, new Set())).toHaveLength(0);
  });

  it('matches an empty change list only against a null fork', async () => {
    await recordFork({ changes: [] });

    const draws = await findReusableDraws(root, 'wf', key({ changes: [] as never }), 'control', 5, new Set());

    expect(draws).toHaveLength(1);
  });

  it('serves nothing when nothing is needed', async () => {
    await recordFork();

    expect(await findReusableDraws(root, 'wf', key(), 'arm', 0, new Set())).toHaveLength(0);
  });
});
