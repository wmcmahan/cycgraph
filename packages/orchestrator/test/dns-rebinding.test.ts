/**
 * Shared connect-time DNS re-check — unit tests for
 * src/security/dns-rebinding.ts.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

import { assertResolvedHostPublic } from '../src/security/dns-rebinding.js';

const PUBLIC_IP = '93.184.216.34';
const METADATA_IP = '169.254.169.254';
const OPTIONS = { allowEnvVar: 'CYCGRAPH_ALLOW_PRIVATE_TEST_URLS', subject: 'test subject "x"' };

beforeEach(() => {
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertResolvedHostPublic', () => {
  it('accepts a host whose addresses are all public', async () => {
    await expect(assertResolvedHostPublic('public.example', OPTIONS)).resolves.toBeUndefined();

    expect(dnsLookupMock).toHaveBeenCalledWith('public.example', { all: true, verbatim: true });
  });

  it('rejects a host that resolves to a private address', async () => {
    dnsLookupMock.mockResolvedValue([{ address: METADATA_IP, family: 4 }]);

    await expect(assertResolvedHostPublic('rebind.example', OPTIONS)).rejects.toThrow(
      'test subject "x" host "rebind.example" resolves to a private/loopback address (169.254.169.254) '
      + 'and is blocked (SSRF guard). Set CYCGRAPH_ALLOW_PRIVATE_TEST_URLS=true to allow it in development.');
  });

  it('fails closed when the lookup errors', async () => {
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(assertResolvedHostPublic('unknown.example', OPTIONS)).rejects.toThrow(
      'test subject "x" host "unknown.example" could not be resolved for SSRF validation: ENOTFOUND');
  });

  it('skips the lookup when the named env var opts out', async () => {
    vi.stubEnv('CYCGRAPH_ALLOW_PRIVATE_TEST_URLS', 'true');
    dnsLookupMock.mockResolvedValue([{ address: METADATA_IP, family: 4 }]);

    await expect(assertResolvedHostPublic('rebind.example', OPTIONS)).resolves.toBeUndefined();
    expect(dnsLookupMock).toHaveBeenCalledTimes(0);
  });

  it('skips the lookup for a literal ipv4 host', async () => {
    await expect(assertResolvedHostPublic('93.184.216.34', OPTIONS)).resolves.toBeUndefined();
    expect(dnsLookupMock).toHaveBeenCalledTimes(0);
  });

  it('skips the lookup for a bracketed ipv6 host', async () => {
    await expect(assertResolvedHostPublic('[2606:2800:220:1:248:1893:25c8:1946]', OPTIONS))
      .resolves.toBeUndefined();
    expect(dnsLookupMock).toHaveBeenCalledTimes(0);
  });
});
