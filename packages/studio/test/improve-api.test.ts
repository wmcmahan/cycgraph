/**
 * Tests for the improve-session API surface: the sessions listing and the
 * catalog resolving 'improve' for topology requests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  InMemoryEventLogWriter,
  InMemoryPersistenceProvider,
} from '@cycgraph/orchestrator';
import { catalogOf } from '../src/scenarios/catalog.js';
import { scenario } from '../src/scenarios/types.js';
import { createDashboard } from '../src/server/index.js';
import { defaultStackConfig, type Stack, type StackConfig } from '../src/stack/index.js';

let root: string;
let running: { close(): void } | undefined;
let port: number;

async function listen(config: StackConfig): Promise<void> {
  const stack: Stack = {
    config,
    available: new Set(),
    gaps: [],
    persistence: new InMemoryPersistenceProvider(),
    eventLog: new InMemoryEventLogWriter(),
    close: async () => {},
  };
  const target = scenario({
    id: 'stub-target',
    title: 'Stub target',
    covers: [],
    requires: [],
    params: z.object({}),
    build: async () => { throw new Error('never built here'); },
  });
  const server = createDashboard(config, stack, undefined, undefined, catalogOf([target]));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  running = server;
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-improve-api-'));
});

afterEach(async () => {
  running?.close();
  running = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('/api/improve/sessions', () => {
  it('lists recorded sessions with their self-describing params', async () => {
    const dir = join(root, 'runs', 'improve-11111111-2222-3333-4444-555555555555');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({
      runId: '11111111-2222-3333-4444-555555555555',
      scenarioId: 'improve',
      params: { target: 'smoke-wasteful', repoRoot: '/tmp/fixture', workspace: '/tmp/ws' },
      stack: {},
      startedAt: '2026-08-20T00:00:00.000Z',
      durationMs: 52000,
      status: 'completed',
    }));

    await listen({ ...defaultStackConfig(), artifactRoot: root });
    const body = await (await fetch(`http://127.0.0.1:${port}/api/improve/sessions`)).json() as {
      sessions: Array<{ runId: string; status: string; params: { target: string } }>;
    };

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.status).toBe('completed');
    expect(body.sessions[0]!.params.target).toBe('smoke-wasteful');
  });

  it('serves an empty list when nothing has run', async () => {
    await listen({ ...defaultStackConfig(), artifactRoot: root });

    const body = await (await fetch(`http://127.0.0.1:${port}/api/improve/sessions`)).json() as {
      sessions: unknown[];
    };

    expect(body.sessions).toEqual([]);
  });
});

describe('/api/graph scenario=improve', () => {
  it('serves the improve session topology through the catalog', async () => {
    await listen({ ...defaultStackConfig(), artifactRoot: root });

    const query = new URLSearchParams({ scenario: 'improve', params: JSON.stringify({ target: 'stub-target' }) });
    const body = await (await fetch(`http://127.0.0.1:${port}/api/graph?${query}`)).json() as {
      graph: { nodes: Array<{ id: string }> };
    };

    const ids = body.graph.nodes.map((n) => n.id);
    expect(ids).toContain('tune');
    expect(ids).toContain('edit');
  });
});
