/**
 * The dashboard's stack lifetime.
 *
 * Tracing and the database pool are process-global. A stack built and closed
 * per request shuts the tracer provider down between the page load and the run
 * it starts, and OpenTelemetry will not re-register a global provider once one
 * exists, so every later run records a trace id whose spans never reach the
 * collector. The stack therefore belongs to the server, and no request may
 * close it.
 *
 * @module test/server-lifetime
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboard } from '../src/server/index.js';
import { catalogOf } from '../src/scenarios/catalog.js';
import { scenario } from '../src/scenarios/types.js';
import { z } from 'zod';
import { defaultStackConfig, type Stack, type StackFeature } from '../src/stack/index.js';

let closes = 0;

/** A stack that records teardown and nothing else — no request should need more. */
function fakeStack(available: StackFeature[] = []): Stack {
  return {
    config: defaultStackConfig(),
    available: new Set(available),
    gaps: [],
    persistence: {} as Stack['persistence'],
    eventLog: {} as Stack['eventLog'],
    close: async () => { closes++; },
  };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

let running: { close(): void } | undefined;


const catalog = catalogOf([scenario({
  id: 'supervisor-swarm',
  title: 'Model-backed fixture',
  covers: [],
  requires: ['model'],
  params: z.object({}),
  build: async () => { throw new Error('never built here'); },
})]);

async function listen(stack: Stack): Promise<number> {
  const server = createDashboard(defaultStackConfig(), stack, undefined, undefined, catalog);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  running = server;
  return (server.address() as AddressInfo).port;
}

afterEach(() => {
  running?.close();
  running = undefined;
  closes = 0;
});

describe('createDashboard', () => {
  it('serves the catalog without closing the stack it was given', async () => {
    const port = await listen(fakeStack(['model']));

    const { status } = await get(port, '/api/scenarios');

    expect({ status, closes }).toEqual({ status: 200, closes: 0 });
  });

  it('leaves the stack open across repeated requests', async () => {
    const port = await listen(fakeStack(['model']));

    await get(port, '/api/scenarios');
    await get(port, '/api/scenarios');
    await get(port, '/api/history');

    expect(closes).toBe(0);
  });

  it('reports a scenario as not runnable when the stack lacks its features', async () => {
    const port = await listen(fakeStack([]));

    const { body } = await get(port, '/api/scenarios');
    const swarm = (body as { scenarios: Array<{ id: string; runnable: boolean; missing: string[] }> })
      .scenarios.find((s) => s.id === 'supervisor-swarm')!;

    expect({ runnable: swarm.runnable, missing: swarm.missing }).toEqual({
      runnable: false,
      missing: ['model'],
    });
  });
});
