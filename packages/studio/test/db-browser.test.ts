/**
 * Tests for the DB run browser (/api/db/*): discovery, timeline, and forking
 * of runs recorded outside the playground through the engine API alone.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { graph, node, runRecorded, tool, type RecordedRun } from '@cycgraph/orchestrator';
import { createDashboard } from '../src/server/index.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';

let recorded: RecordedRun;
let running: { close(): void } | undefined;
let port: number;

beforeAll(async () => {
  const echo = tool({
    name: 'echo',
    description: 'Echoes.',
    parameters: z.object({}),
    execute: () => ({ said: 'external' }),
  });
  const external = graph({
    name: 'external-flow',
    nodes: [node({ id: 'say', type: 'tool', toolId: 'echo', tools: [echo] })],
  });
  recorded = await runRecorded(external, { goal: 'An external run.' });
});

afterEach(() => {
  running?.close();
  running = undefined;
});

async function listen(): Promise<void> {
  const config = {
    ...defaultStackConfig(),
    postgres: false,
    artifactRoot: await mkdtemp(join(tmpdir(), 'cycgraph-dbb-')),
  };
  const stack: Stack = {
    config,
    available: new Set(),
    gaps: [],
    persistence: recorded.persistence,
    eventLog: recorded.eventLog,
    close: async () => {},
  };
  const server = createDashboard(config, stack);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  running = server;
  port = (server.address() as AddressInfo).port;
}

describe('/api/db/runs', () => {
  it('discovers a run recorded outside the playground and marks it external', async () => {
    await listen();

    const body = await (await fetch(`http://127.0.0.1:${port}/api/db/runs`)).json() as {
      runs: Array<{ runId: string; status: string; hasArtifacts: boolean }>;
    };

    const row = body.runs.find((run) => run.runId === recorded.runId);
    expect(row?.status).toBe('completed');
    expect(row?.hasArtifacts).toBe(false);
  });

  it('reports the store as non-durable when postgres is not available', async () => {
    await listen();

    const body = await (await fetch(`http://127.0.0.1:${port}/api/db/runs`)).json() as {
      durable: boolean;
    };

    expect(body.durable).toBe(false);
  });
});

describe('/api/db/run', () => {
  it('serves the timeline and fork boundaries from the event log', async () => {
    await listen();

    const body = await (await fetch(
      `http://127.0.0.1:${port}/api/db/run?id=${recorded.runId}`)).json() as {
      graphName: string;
      timeline: Array<{ type: string; nodeId?: string }>;
      forkPoints: Array<{ beforeNode: string }>;
    };

    expect(body.graphName).toBe('external-flow');
    expect(body.timeline.map((event) => event.type)).toContain('node_started');
    expect(body.forkPoints.map((point) => point.beforeNode)).toContain('say');
  });

  it('answers 404 for a run persistence does not hold', async () => {
    await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/db/run?id=missing`);

    expect(response.status).toBe(404);
  });
});

describe('/api/db/fork', () => {
  it('forks an external run at a boundary and reports the variant', async () => {
    await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/db/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: recorded.runId, beforeNode: 'say' }),
    });
    const body = await response.json() as {
      runId: string; status: string; forkNodeId: string;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.forkNodeId).toBe('say');
    expect(body.runId).not.toBe(recorded.runId);
  });

  it('answers 422 with the engine error for an unforkable request', async () => {
    await listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/db/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: recorded.runId, beforeNode: 'no-such-node' }),
    });

    expect(response.status).toBe(422);
  });
});
