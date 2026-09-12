/**
 * Tests for the SDK client factory's Agent Card handling and for the
 * per-request fetch its transport issues.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

import { requestFetch, sdkClientFactory } from '../src/connection.js';

const CARD_URL = 'http://agent.example';
const PUBLIC_IP = '93.184.216.34';
const METADATA_IP = '169.254.169.254';

function cardResponse(endpointUrl = `${CARD_URL}/rpc`, extra: Record<string, unknown> = {}): Response {
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
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function settled(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

beforeEach(() => {
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

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

  it('refuses a card whose supported interface points at a private host', async () => {
    const fetchMock = vi.fn(async () => cardResponse(`${CARD_URL}/rpc`, {
      supportedInterfaces: [{ url: 'http://169.254.169.254/latest/meta-data', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {}))
      .rejects.toThrow('agent card endpoint "http://169.254.169.254/latest/meta-data" points at a private/loopback host');
  });

  it('refuses a card whose additional interface points at a private host', async () => {
    const fetchMock = vi.fn(async () => cardResponse(`${CARD_URL}/rpc`, {
      additionalInterfaces: [{ url: 'http://10.0.0.5/rpc', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {}))
      .rejects.toThrow('agent card endpoint "http://10.0.0.5/rpc" points at a private/loopback host');
  });

  it('refuses a card whose additional interface is not http(s)', async () => {
    const fetchMock = vi.fn(async () => cardResponse(`${CARD_URL}/rpc`, {
      additionalInterfaces: [{ url: 'file:///etc/passwd', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow('must use http(s)');
  });

  it('refuses a card whose public endpoint host resolves to a private address', async () => {
    dnsLookupMock.mockResolvedValue([{ address: METADATA_IP, family: 4 }]);
    const fetchMock = vi.fn(async () => cardResponse('https://rebind.example/rpc'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow(
      'agent card endpoint "https://rebind.example/rpc" host "rebind.example" '
      + 'resolves to a private/loopback address (169.254.169.254)');
  });

  it('refuses a card whose secondary endpoint host resolves to a private address', async () => {
    dnsLookupMock.mockImplementation(async (host: string) =>
      (host === 'rebind.example' ? [{ address: METADATA_IP, family: 4 }] : [{ address: PUBLIC_IP, family: 4 }]));
    const fetchMock = vi.fn(async () => cardResponse(`${CARD_URL}/rpc`, {
      additionalInterfaces: [{ url: 'https://rebind.example/rpc', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow(
      'agent card endpoint "https://rebind.example/rpc" host "rebind.example" '
      + 'resolves to a private/loopback address (169.254.169.254)');
  });

  it('refuses a card endpoint whose host cannot be resolved', async () => {
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const fetchMock = vi.fn(async () => cardResponse('https://unknown.example/rpc'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();

    await expect(create(CARD_URL, {})).rejects.toThrow(
      'agent card endpoint "https://unknown.example/rpc" host "unknown.example" could not be resolved '
      + 'for SSRF validation: ENOTFOUND');
  });

  it('skips the dns re-check under the development opt-out', async () => {
    vi.stubEnv('CYCGRAPH_ALLOW_PRIVATE_A2A_URLS', 'true');
    const fetchMock = vi.fn(async () => cardResponse('http://127.0.0.1:9999/rpc'));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, {}));

    expect(dnsLookupMock).toHaveBeenCalledTimes(0);
  });

  it('resolves a host shared by several endpoints once', async () => {
    const fetchMock = vi.fn(async () => cardResponse('https://agent.example/rpc', {
      supportedInterfaces: [{ url: 'https://agent.example/jsonrpc', transport: 'JSONRPC' }],
      additionalInterfaces: [{ url: 'https://agent.example/extra', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, {}));

    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });

  it('resolves distinct endpoint hosts concurrently', async () => {
    let secondStarted!: () => void;
    const secondHasStarted = new Promise<void>((resolve) => { secondStarted = resolve; });
    dnsLookupMock.mockImplementation(async (host: string) => {
      if (host === 'two.example') secondStarted();
      else await secondHasStarted;
      return [{ address: PUBLIC_IP, family: 4 }];
    });
    const fetchMock = vi.fn(async () => cardResponse('https://one.example/rpc', {
      additionalInterfaces: [{ url: 'https://two.example/rpc', transport: 'JSONRPC' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    await settled(create(CARD_URL, {}));

    expect(dnsLookupMock).toHaveBeenCalledTimes(2);
  });

  it('fails the guard when the caller aborts before the dns re-check settles', async () => {
    dnsLookupMock.mockImplementation(() => new Promise(() => undefined));
    const fetchMock = vi.fn(async () => cardResponse('https://slow.example/rpc'));
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();

    const create = sdkClientFactory();
    const creating = create(CARD_URL, {}, caller.signal);
    caller.abort();

    await expect(creating).rejects.toThrow(
      'agent card endpoint SSRF validation did not complete before the caller aborted (SSRF guard)');
  });

  it('accepts a card whose secondary endpoints are all public', async () => {
    const fetchMock = vi.fn(async () => cardResponse(`${CARD_URL}/rpc`, {
      supportedInterfaces: [
        { url: 'https://agent.example/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
      ],
      additionalInterfaces: [
        { url: 'https://agent.example/extra', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory();
    const client = await create(CARD_URL, {});

    expect(typeof client.sendMessage).toBe('function');
  });

  it('rejects card resolution that outruns the card timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const create = sdkClientFactory({ cardTimeoutMs: 5 });

    await expect(create(CARD_URL, {})).rejects.toThrow('agent card resolution did not complete within the 5ms budget');
  });

  it('retries card resolution after a fetch that never settles', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockImplementation(async () => cardResponse());
    vi.stubGlobal('fetch', fetchMock);

    const create = sdkClientFactory({ cardTimeoutMs: 5 });
    await expect(create(CARD_URL, {}))
      .rejects.toThrow('agent card resolution did not complete within the 5ms budget');
    await settled(create(CARD_URL, {}));

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
