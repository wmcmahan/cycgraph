/**
 * MCP Transport Security — unit tests for src/mcp/transport-security.ts.
 *
 * Covers the stdio env scrubber and the connect-time SSRF DNS re-check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { scrubStdioEnv, assertHostResolvesPublic } from '../src/mcp/transport-security.js';

const PUBLIC_IP = '93.184.216.34';
const METADATA_IP = '169.254.169.254';

describe('scrubStdioEnv', () => {
  it('strips exact-match code-injection env vars', () => {
    const { env, dropped } = scrubStdioEnv({ NODE_OPTIONS: '--require=/tmp/evil.js', SAFE: 'keep' });

    expect(env).toEqual({ SAFE: 'keep' });
    expect(dropped).toEqual(['NODE_OPTIONS']);
  });

  it('matches dangerous names case-insensitively', () => {
    const { env, dropped } = scrubStdioEnv({ Node_Options: '--require=/tmp/evil.js' });

    expect(env).toEqual({});
    expect(dropped).toEqual(['Node_Options']);
  });

  it('strips names matching a dangerous prefix', () => {
    const { env, dropped } = scrubStdioEnv({ DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', KEEP: 'v' });

    expect(env).toEqual({ KEEP: 'v' });
    expect(dropped).toEqual(['DYLD_INSERT_LIBRARIES']);
  });

  it('returns an empty result for undefined env', () => {
    expect(scrubStdioEnv(undefined)).toEqual({ env: {}, dropped: [] });
  });
});

describe('assertHostResolvesPublic', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
  });

  afterEach(() => {
    delete process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS;
  });

  it('returns without resolving when the operator escape hatch is set', async () => {
    process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS = 'true';
    dnsLookupMock.mockResolvedValue([{ address: METADATA_IP, family: 4 }]);

    await expect(assertHostResolvesPublic('http://internal.example.com', 'srv')).resolves.toBeUndefined();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it('returns silently for a malformed URL', async () => {
    await expect(assertHostResolvesPublic('not a url', 'srv')).resolves.toBeUndefined();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it('strips IPv6 brackets before resolving', async () => {
    await assertHostResolvesPublic('https://[2606:2800:220:1:248:1893:25c8:1946]/mcp', 'srv');

    expect(dnsLookupMock).toHaveBeenCalledWith('2606:2800:220:1:248:1893:25c8:1946', { all: true });
  });

  it('resolves for a host that maps to a public address', async () => {
    await expect(assertHostResolvesPublic('https://mcp.example.com/api', 'srv')).resolves.toBeUndefined();
  });

  it('throws when the host resolves to a private/loopback address', async () => {
    dnsLookupMock.mockResolvedValue([{ address: METADATA_IP, family: 4 }]);

    await expect(assertHostResolvesPublic('https://legit.example.com/api', 'rebind'))
      .rejects.toThrow(/private\/loopback/i);
  });

  it('fails closed when resolution errors', async () => {
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(assertHostResolvesPublic('https://nope.example.com/api', 'srv'))
      .rejects.toThrow(/could not be resolved/i);
  });
});
