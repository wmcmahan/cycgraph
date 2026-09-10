/**
 * Tests for the SDK client factory's Agent Card handling.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { sdkClientFactory } from '../src/connection.js';

const CARD_URL = 'http://agent.example';

function cardResponse(): Response {
  return new Response(JSON.stringify({
    name: 'scenario',
    description: '',
    version: '1',
    protocolVersion: '1.0',
    url: `${CARD_URL}/rpc`,
    preferredTransport: 'JSONRPC',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function settled(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sdkClientFactory', () => {
  it('sends the per-server headers on the agent card request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { authorization: 'Bearer sesame' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sesame');
  });

  it('shares one card fetch between calls for the same url', async () => {
    const fetchMock = vi.fn(async () => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, {}));
    await settled(create(CARD_URL, {}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the card again for the same url with different headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { authorization: 'Bearer tenant-a' }));
    await settled(create(CARD_URL, { authorization: 'Bearer tenant-b' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>).authorization)
      .toBe('Bearer tenant-b');
  });

  it('shares one card fetch for equivalent header sets', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { Authorization: 'Bearer sesame', 'x-api-key': '1' }));
    await settled(create(CARD_URL, { 'x-api-key': '1', authorization: 'Bearer sesame' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one card fetch across calls differing only in trace headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { authorization: 'Bearer sesame', traceparent: '00-a-1-01' }));
    await settled(create(CARD_URL, { authorization: 'Bearer sesame', traceparent: '00-b-2-01' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries card resolution after a failure instead of caching the rejection', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementation(async () => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await expect(create(CARD_URL, {})).rejects.toThrow();
    await settled(create(CARD_URL, {}));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
