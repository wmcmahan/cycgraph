import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TaskState } from '@a2a-js/sdk';
import { STATE_VALUE } from './server.js';
import type { ScenarioState } from './scenarios.js';

// Bound before any test replaces globalThis.fetch: requests to the app under
// test have to reach its loopback socket, not the Ollama tag-list stub.
const realFetch = globalThis.fetch.bind(globalThis);

const OLLAMA_URL = 'http://ollama.test';
const PROBE_MODEL = 'probe-model:1b';
const PROBE_TTL_MS = 10_000;

const ALL_STATES: ScenarioState[] = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
];

interface IndexBody {
  agents: Array<{ id: string }>;
  unavailable: Array<{ id: string; reason: string }>;
}

let pulledTags: string[] = [];
let httpServer: Server | undefined;

function makeProbe() {
  return vi.fn(async () => new Response(
    JSON.stringify({ models: pulledTags.map((name) => ({ name })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

let probe = makeProbe();

async function startScenarioServer(): Promise<string> {
  vi.resetModules();
  const { createA2AScenarioServer } = await import('./server.js');
  const listening = createA2AScenarioServer(OLLAMA_URL).listen(0, '127.0.0.1');
  await once(listening, 'listening');
  httpServer = listening;
  const { port } = listening.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function loadModelAvailable(model: string): Promise<(timeoutMs?: number) => Promise<boolean>> {
  vi.stubEnv('A2A_AGENT_MODEL', model);
  vi.resetModules();
  const { modelAvailable } = await import('./agent.js');
  return modelAvailable;
}

beforeEach(() => {
  pulledTags = [];
  probe = makeProbe();
  vi.stubEnv('OLLAMA_BASE_URL', OLLAMA_URL);
  vi.stubEnv('A2A_AGENT_MODEL', PROBE_MODEL);
  vi.stubGlobal('fetch', probe);
});

afterEach(() => {
  httpServer?.closeAllConnections();
  httpServer?.close();
  httpServer = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('STATE_VALUE', () => {
  it('maps every scenario state to its SDK enum member', () => {
    const mapped = ALL_STATES.map((state) => STATE_VALUE[state]);

    expect(mapped).toEqual([
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_REJECTED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      TaskState.TASK_STATE_AUTH_REQUIRED,
    ]);
  });

  it('carries an entry for every scenario state and no others', () => {
    const keys = Object.keys(STATE_VALUE).sort();

    expect(keys).toEqual([...ALL_STATES].sort());
  });

  it('maps to numbers rather than to the state names', () => {
    const kinds = ALL_STATES.map((state) => typeof STATE_VALUE[state]);

    expect(kinds).toEqual(ALL_STATES.map(() => 'number'));
  });
});

describe('modelAvailable', () => {
  it('accepts a bare configured tag that Ollama reports as name:latest', async () => {
    pulledTags = ['bare-model:latest'];
    const modelAvailable = await loadModelAvailable('bare-model');

    const available = await modelAvailable();

    expect(available).toBe(true);
    expect(probe.mock.calls[0]![0]).toBe(`${OLLAMA_URL}/api/tags`);
  });

  it('accepts a qualified tag reported verbatim', async () => {
    pulledTags = [PROBE_MODEL];
    const modelAvailable = await loadModelAvailable(PROBE_MODEL);

    const available = await modelAvailable();

    expect(available).toBe(true);
  });

  it('rejects a tag list that does not hold the configured model', async () => {
    pulledTags = ['other-model:latest'];
    const modelAvailable = await loadModelAvailable('bare-model');

    const available = await modelAvailable();

    expect(available).toBe(false);
  });

  it('rejects a daemon with nothing pulled at all', async () => {
    pulledTags = [];
    const modelAvailable = await loadModelAvailable('bare-model');

    const available = await modelAvailable();

    expect(available).toBe(false);
  });

  it('rejects a tag list answered with an error status', async () => {
    const modelAvailable = await loadModelAvailable(PROBE_MODEL);
    probe.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    const available = await modelAvailable();

    expect(available).toBe(false);
  });

  it('reports the model unreachable when the probe throws', async () => {
    const modelAvailable = await loadModelAvailable(PROBE_MODEL);
    probe.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const available = await modelAvailable();

    expect(available).toBe(false);
  });
});

describe('model-backed scenario advertising', () => {
  it('withholds the agent card while no model is reachable', async () => {
    pulledTags = [];
    const baseUrl = await startScenarioServer();

    const response = await realFetch(`${baseUrl}/agent/.well-known/agent-card.json`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'scenario agent needs a model and none is reachable',
    });
  });

  it('lists every model-backed scenario as unavailable while no model is reachable', async () => {
    pulledTags = [];
    const baseUrl = await startScenarioServer();

    const body = (await (await realFetch(`${baseUrl}/`)).json()) as IndexBody;

    expect(body.unavailable).toEqual([
      { id: 'agent', reason: 'no model reachable' },
      { id: 'agent-clarifies', reason: 'no model reachable' },
    ]);
    expect(body.agents.map((agent) => agent.id)).toEqual([
      'echo',
      'multi-artifact',
      'asks-question',
      'rejects',
      'fails',
      'needs-auth',
      'unnamed-artifact',
    ]);
  });

  it('serves the agent card once the configured model is pulled', async () => {
    pulledTags = [PROBE_MODEL];
    const baseUrl = await startScenarioServer();

    const response = await realFetch(`${baseUrl}/agent/.well-known/agent-card.json`);
    const card = (await response.json()) as { name: string };

    expect(response.status).toBe(200);
    expect(card.name).toBe('scenario-agent');
  });
});

describe('model reachability cache', () => {
  it('probes once for every request inside the TTL window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    pulledTags = [];
    const baseUrl = await startScenarioServer();

    await realFetch(`${baseUrl}/`);
    await realFetch(`${baseUrl}/`);
    await realFetch(`${baseUrl}/agent/.well-known/agent-card.json`);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probes again once the TTL has elapsed', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    pulledTags = [];
    const baseUrl = await startScenarioServer();
    await realFetch(`${baseUrl}/`);

    pulledTags = [PROBE_MODEL];
    clock.mockReturnValue(1_000_000 + PROBE_TTL_MS);
    const body = (await (await realFetch(`${baseUrl}/`)).json()) as IndexBody;

    expect(probe).toHaveBeenCalledTimes(2);
    expect(body.unavailable).toEqual([]);
    expect(body.agents.map((agent) => agent.id)).toContain('agent');
  });
});
