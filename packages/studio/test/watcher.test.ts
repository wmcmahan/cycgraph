/**
 * Tests for the serve-side watcher (src/server/watcher.ts): trigger policy
 * over an injected tick, and the dashboard routes that expose it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createWatcher } from '../src/server/watcher.js';
import type { WatchRow } from '../src/improve/watch.js';
import { createDashboard } from '../src/server/index.js';
import { saveProposals, listProposals } from '../src/improve/proposals.js';
import type { TuneOutcome } from '../src/improve/tune.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';

const ROW: WatchRow = {
  workflow: 'wf',
  outcome: 'kept',
  detail: 'measured',
  forks: 1,
  proposals: [],
};

function fakeStack(artifactRoot = '/tmp/unused'): Stack {
  return {
    config: { ...defaultStackConfig(), artifactRoot },
    available: new Set(),
    gaps: [],
    persistence: {} as Stack['persistence'],
    eventLog: {} as Stack['eventLog'],
    close: async () => {},
  };
}

function countingTick() {
  let calls = 0;
  const tick = async (): Promise<WatchRow[]> => {
    calls++;
    return [ROW];
  };
  return { tick, calls: () => calls };
}

describe('createWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks after a full batch of completed runs', async () => {
    const { tick, calls } = countingTick();
    const watcher = createWatcher(fakeStack(), { auto: true, debounceRuns: 3, tick });

    for (let i = 0; i < 3; i++) {
      watcher.noteRunStarted();
      watcher.noteRunFinished();
    }
    expect(calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(calls()).toBe(1);
    expect(watcher.snapshot().pendingRuns).toBe(0);
    watcher.close();
  });

  it('flushes a partial batch after the quiet period', async () => {
    const { tick, calls } = countingTick();
    const watcher = createWatcher(fakeStack(), { auto: true, debounceRuns: 5, quietMs: 60_000, tick });

    watcher.noteRunStarted();
    watcher.noteRunFinished();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls()).toBe(1);
    watcher.close();
  });

  it('defers while a run is in flight and retries once it is not', async () => {
    const { tick, calls } = countingTick();
    const watcher = createWatcher(fakeStack(), { auto: true, debounceRuns: 1, tick });

    watcher.noteRunStarted();
    watcher.noteRunFinished();
    watcher.noteRunStarted();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(0);

    watcher.noteRunFinished();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(calls()).toBeGreaterThanOrEqual(1);
    watcher.close();
  });

  it('never ticks automatically when auto is off', async () => {
    const { tick, calls } = countingTick();
    const watcher = createWatcher(fakeStack(), { auto: false, debounceRuns: 1, quietMs: 1_000, tick });

    watcher.noteRunStarted();
    watcher.noteRunFinished();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls()).toBe(0);
    expect(watcher.snapshot().pendingRuns).toBe(1);
    watcher.close();
  });

  it('refuses a manual tick while one is running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const watcher = createWatcher(fakeStack(), {
      auto: false,
      tick: async () => { await gate; return [ROW]; },
    });

    const first = watcher.tickNow();
    await expect(watcher.tickNow()).rejects.toThrow('already running');

    release();
    await expect(first).resolves.toEqual([ROW]);
    watcher.close();
  });
});

describe('dashboard watch routes', () => {
  let root: string;
  let running: { close(): void } | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cycgraph-watch-api-'));
  });
  afterEach(async () => {
    running?.close();
    running = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const proposalOutcome = (): TuneOutcome => ({
    workflow: 'wf',
    baseRunIds: ['base-a'],
    sweeps: [],
    estimates: [],
    forks: 0,
    verdicts: [{
      kind: 'proposal',
      proposal: {
        sweepId: 'sweep:wf:boss:supervisor_config.max_iterations',
        workflow: 'wf',
        nodeId: 'boss',
        knob: 'supervisor_config.max_iterations',
        from: 8,
        to: 4,
        objective: 'cost',
        model: 'm',
        change: [{ kind: 'config', node_id: 'boss', patch: { supervisor_config: { max_iterations: 4 } } }],
        computeDelta: 0.4,
        tokenDelta: 0.4,
        measuredOn: ['base-a'],
        outcomes: [],
      },
    }],
  });

  async function listen(withWatcher = true) {
    const stack = fakeStack(root);
    const config = { ...defaultStackConfig(), artifactRoot: root };
    const { tick, calls } = countingTick();
    const watcher = withWatcher ? createWatcher(stack, { auto: false, tick }) : undefined;
    const server = createDashboard(config, stack, watcher);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    running = server;
    const port = (server.address() as AddressInfo).port;
    return { port, calls };
  }

  it('reports the watcher state and the ledger together', async () => {
    await saveProposals(root, proposalOutcome());
    const { port } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/watch`);
    const body = await response.json() as { watcher: { auto: boolean }; proposals: Array<{ status: string }> };

    expect(body.watcher.auto).toBe(false);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.status).toBe('proposed');
  });

  it('runs a tick on demand', async () => {
    const { port, calls } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/watch/tick`, { method: 'POST' });
    const body = await response.json() as { rows: WatchRow[] };

    expect(response.status).toBe(200);
    expect(body.rows).toEqual([ROW]);
    expect(calls()).toBe(1);
  });

  it('streams an error for an apply of an unknown proposal', async () => {
    const { port } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'no-such-proposal' }),
    });
    const text = await response.text();

    expect(text).toContain('event: error');
    expect(text).toContain("no proposal 'no-such-proposal'");
  });

  it('serves the persisted tick history', async () => {
    const { port } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/watch/history`);
    const body = await response.json() as { ticks: unknown[] };

    expect(response.status).toBe(200);
    expect(body.ticks).toEqual([]);
  });

  it('walks a proposal to trial from the page', async () => {
    await saveProposals(root, proposalOutcome());
    const { port } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/proposals/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sweep:wf:boss:supervisor_config.max_iterations', action: 'trial' }),
    });

    expect(response.status).toBe(200);
    const [record] = await listProposals(root);
    expect(record?.status).toBe('trial');
  });
});
