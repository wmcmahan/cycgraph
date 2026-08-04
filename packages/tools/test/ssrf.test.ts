/**
 * Tests for the SSRF guard (src/web/ssrf.ts): scheme and host policy, the
 * DNS re-check, per-hop redirect validation, and capped body reads.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { assertUrlPublic, guardedFetch, readBodyCapped, SsrfBlockedError, MAX_REDIRECTS } =
  await import('../src/web/ssrf.js');

const PUBLIC_ADDRESS = [{ address: '93.184.216.34' }];

beforeEach(() => {
  lookup.mockResolvedValue(PUBLIC_ADDRESS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
});

describe('assertUrlPublic', () => {
  it('accepts a public hostname that resolves publicly', async () => {
    await expect(assertUrlPublic(new URL('https://example.com/page'))).resolves.toBeUndefined();
  });

  it('rejects non-http schemes', async () => {
    await expect(assertUrlPublic(new URL('ftp://example.com'))).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects loopback literals', async () => {
    await expect(assertUrlPublic(new URL('http://127.0.0.1/'))).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects decimal-encoded loopback literals', async () => {
    await expect(assertUrlPublic(new URL('http://2130706433/'))).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(assertUrlPublic(new URL('http://169.254.169.254/'))).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('rejects localhost by name without a DNS lookup', async () => {
    await expect(assertUrlPublic(new URL('http://localhost:8080/'))).rejects.toThrow(
      SsrfBlockedError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a public name that resolves to a private address (DNS rebinding)', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5' }]);

    await expect(assertUrlPublic(new URL('https://rebind.example.com/'))).rejects.toThrow(
      /resolves to a private address/,
    );
  });

  it('rejects a name that fails to resolve', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(assertUrlPublic(new URL('https://nope.example.com/'))).rejects.toThrow(
      /could not be resolved/,
    );
  });

  it('skips all checks when allowPrivateHosts is set', async () => {
    await expect(
      assertUrlPublic(new URL('http://127.0.0.1/'), true),
    ).resolves.toBeUndefined();
  });
});

describe('guardedFetch', () => {
  it('returns the response and final URL for a direct hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    const { response, finalUrl } = await guardedFetch('https://example.com/a', {});

    expect(response.status).toBe(200);
    expect(finalUrl).toBe('https://example.com/a');
  });

  it('follows a redirect to a public host and validates each hop', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://other.example.com/b' } }),
      )
      .mockResolvedValueOnce(new Response('landed', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const { response, finalUrl } = await guardedFetch('https://example.com/a', {});

    expect(response.status).toBe(200);
    expect(finalUrl).toBe('https://other.example.com/b');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('blocks a redirect into a private host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    ));

    await expect(guardedFetch('https://example.com/a', {})).rejects.toThrow(SsrfBlockedError);
  });

  it('returns a 3xx response that has no location header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })));

    const { response } = await guardedFetch('https://example.com/a', {});

    expect(response.status).toBe(304);
  });

  it('gives up after the redirect cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
    ));

    await expect(guardedFetch('https://example.com/a', {})).rejects.toThrow(
      new RegExp(`Exceeded ${MAX_REDIRECTS} redirects`),
    );
  });
});

describe('readBodyCapped', () => {
  it('returns the full body when under the cap', async () => {
    const { body, truncated } = await readBodyCapped(new Response('hello world'), 1024);

    expect(body).toBe('hello world');
    expect(truncated).toBe(false);
  });

  it('truncates the body at the cap and flags it', async () => {
    const { body, truncated } = await readBodyCapped(new Response('a'.repeat(100)), 10);

    expect(body).toBe('a'.repeat(10));
    expect(truncated).toBe(true);
  });

  it('handles a bodyless response', async () => {
    const { body, truncated } = await readBodyCapped(new Response(null, { status: 204 }), 10);

    expect(body).toBe('');
    expect(truncated).toBe(false);
  });
});
