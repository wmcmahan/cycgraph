/**
 * Tests for the SDK client factory's Agent Card handling and for the
 * per-request fetch its transport issues.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { requestFetch, sdkClientFactory } from '../src/connection.js';

const CARD_URL = 'http://agent.example';

function cardResponse(endpointUrl = `${CARD_URL}/rpc`): Response {
  return new Response(JSON.stringify({
    name: 'scenario',
    description: '',
    version: '1',
    protocolVersion: '1.0',
    url: endpointUrl,
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
  vi.unstubAllEnvs();
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

  it('resolves the card again for header sets that differ only in where the delimiter falls', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { authorization: 'Bearer sesame', 'x-api-key': 'tenant-a' }));
    await settled(create(CARD_URL, { authorization: 'Bearer sesame,x-api-key:tenant-a' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one card fetch across calls differing only in trace headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, { authorization: 'Bearer sesame', traceparent: '00-a-1-01' }));
    await settled(create(CARD_URL, { authorization: 'Bearer sesame', traceparent: '00-b-2-01' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a card whose endpoint points at a private host', async () => {
    const fetchMock = vi.fn(async () => cardResponse('http://169.254.169.254/rpc'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow('SSRF guard');
  });

  it('honors the development opt-out for private endpoints', async () => {
    vi.stubEnv('CYCGRAPH_ALLOW_PRIVATE_A2A_URLS', 'true');
    const fetchMock = vi.fn(async () => cardResponse('http://127.0.0.1:9999/rpc'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    const outcome = await create(CARD_URL, {}).then(() => 'created', (error: Error) => error.message);

    expect(outcome).toBe('No compatible transport found, available transports: JSONRPC');
  });

  it('refuses a card whose endpoint is not http(s)', async () => {
    const fetchMock = vi.fn(async () => cardResponse('file:///etc/passwd'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow('must use http(s)');
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

describe('requestFetch', () => {
  function okFetch() {
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  }

  function sentSignal(fetchMock: ReturnType<typeof okFetch>): AbortSignal {
    return fetchMock.mock.calls[0]![1]!.signal!;
  }

  it('aborts the request when the delivery bound fires and the sdk carries its own signal', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const sdk = new AbortController();
    const delivery = new AbortController();

    await requestFetch({}, delivery.signal)(`${CARD_URL}/rpc`, { signal: sdk.signal });
    delivery.abort();

    expect(sentSignal(fetchMock).aborted).toBe(true);
  });

  it('aborts the request when the sdk aborts its own signal', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const sdk = new AbortController();
    const delivery = new AbortController();

    await requestFetch({}, delivery.signal)(`${CARD_URL}/rpc`, { signal: sdk.signal });
    sdk.abort();

    expect(sentSignal(fetchMock).aborted).toBe(true);
  });

  it('sends the delivery bound itself when the sdk sets no signal', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const delivery = new AbortController();

    await requestFetch({}, delivery.signal)(`${CARD_URL}/rpc`, {});

    expect(sentSignal(fetchMock)).toBe(delivery.signal);
  });

  it('leaves the sdk signal untouched when there is no delivery bound', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const sdk = new AbortController();

    await requestFetch({})(`${CARD_URL}/rpc`, { signal: sdk.signal });

    expect(sentSignal(fetchMock)).toBe(sdk.signal);
  });

  it('applies the per-server headers over the sdk headers', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await requestFetch({ authorization: 'Bearer sesame' })(`${CARD_URL}/rpc`, {
      headers: { authorization: 'Bearer stale', 'content-type': 'application/json' },
    });

    expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({
      authorization: 'Bearer sesame',
      'content-type': 'application/json',
    });
  });
});
