/**
 * Tests for the A2A server registry (a2a/schema.ts, a2a/in-memory-registry.ts).
 *
 * The registry is a trust boundary, so the cases that matter are the ones
 * that try to get past it: private hosts, non-http schemes, tampered rows,
 * and credentials that should never be storable as literals.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  A2AServerEntrySchema,
  A2ACredentialError,
  resolveAuthHeaders,
} from '../src/a2a/schema.js';
import { InMemoryA2AServerRegistry } from '../src/a2a/in-memory-registry.js';

const VALID = {
  id: 'research-service',
  name: 'Research Service',
  agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
};

afterEach(() => {
  delete process.env.CYCGRAPH_ALLOW_PRIVATE_A2A_URLS;
  delete process.env.A2A_TOKEN;
});

describe('A2AServerEntrySchema', () => {
  it('accepts a public https agent card url', () => {
    const entry = A2AServerEntrySchema.parse({ ...VALID, agent_card_url: VALID.agentCardUrl });

    expect(entry.agent_card_url).toBe(VALID.agentCardUrl);
  });

  it('applies defaults for auth, timeouts, and retries', () => {
    const entry = A2AServerEntrySchema.parse({ ...VALID, agent_card_url: VALID.agentCardUrl });

    expect(entry.auth).toEqual({ type: 'none' });
    expect(entry.timeout_ms).toBe(30_000);
    expect(entry.task_timeout_ms).toBe(600_000);
    expect(entry.max_retries).toBe(2);
  });

  it('rejects a loopback host', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: 'https://127.0.0.1/.well-known/agent-card.json',
    })).toThrow(/SSRF guard/);
  });

  it('rejects the cloud metadata endpoint', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: 'http://169.254.169.254/latest/meta-data/',
    })).toThrow(/SSRF guard/);
  });

  it('rejects a private range host', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: 'https://10.0.0.5/agent-card.json',
    })).toThrow(/SSRF guard/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: 'file:///etc/passwd',
    })).toThrow();
  });

  it('allows a private host only when the A2A opt-out is set', () => {
    const local = { ...VALID, agent_card_url: 'http://localhost:4000/agent-card.json' };

    expect(() => A2AServerEntrySchema.parse(local)).toThrow(/SSRF guard/);

    process.env.CYCGRAPH_ALLOW_PRIVATE_A2A_URLS = 'true';
    expect(A2AServerEntrySchema.parse(local).agent_card_url).toBe(local.agent_card_url);
  });

  it('does not honour the MCP opt-out for A2A urls', () => {
    process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS = 'true';

    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: 'http://localhost:4000/agent-card.json',
    })).toThrow(/SSRF guard/);

    delete process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS;
  });

  it('refuses a literal token in place of an env var reference', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID,
      agent_card_url: VALID.agentCardUrl,
      auth: { type: 'bearer', token: 'sk-live-abc123' },
    })).toThrow();
  });

  it('accepts bare hostnames as allowed endpoint hosts', () => {
    const entry = A2AServerEntrySchema.parse({
      ...VALID,
      agent_card_url: VALID.agentCardUrl,
      allowed_endpoint_hosts: ['rpc.example.com', 'RPC2.example.com', '[2001:db8::1]'],
    });

    expect(entry.allowed_endpoint_hosts).toEqual(['rpc.example.com', 'RPC2.example.com', '[2001:db8::1]']);
  });

  it('leaves allowed endpoint hosts absent when the entry omits them', () => {
    const entry = A2AServerEntrySchema.parse({ ...VALID, agent_card_url: VALID.agentCardUrl });

    expect(entry.allowed_endpoint_hosts).toBeUndefined();
  });

  it('rejects an allowed endpoint host carrying a scheme', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: VALID.agentCardUrl, allowed_endpoint_hosts: ['https://rpc.example'],
    })).toThrow(/bare hostname/);
  });

  it('rejects an allowed endpoint host carrying a port', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: VALID.agentCardUrl, allowed_endpoint_hosts: ['rpc.example:8080'],
    })).toThrow(/bare hostname/);
  });

  it('rejects an allowed endpoint host carrying a path', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: VALID.agentCardUrl, allowed_endpoint_hosts: ['rpc.example/rpc'],
    })).toThrow(/bare hostname/);
  });

  it('rejects an empty allowed endpoint host', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, agent_card_url: VALID.agentCardUrl, allowed_endpoint_hosts: [''],
    })).toThrow();
  });

  it('rejects an id with characters outside the allowed set', () => {
    expect(() => A2AServerEntrySchema.parse({
      ...VALID, id: 'has spaces', agent_card_url: VALID.agentCardUrl,
    })).toThrow();
  });
});

describe('resolveAuthHeaders', () => {
  it('returns no headers for unauthenticated servers', () => {
    expect(resolveAuthHeaders({ type: 'none' })).toEqual({});
  });

  it('reads a bearer token from the named environment variable', () => {
    process.env.A2A_TOKEN = 'secret-value';

    expect(resolveAuthHeaders({ type: 'bearer', token_env: 'A2A_TOKEN' }))
      .toEqual({ authorization: 'Bearer secret-value' });
  });

  it('reads a custom header value from the named environment variable', () => {
    process.env.A2A_TOKEN = 'secret-value';

    expect(resolveAuthHeaders({ type: 'header', header: 'x-api-key', value_env: 'A2A_TOKEN' }))
      .toEqual({ 'x-api-key': 'secret-value' });
  });

  it('throws when the named variable is absent rather than sending nothing', () => {
    expect(() => resolveAuthHeaders({ type: 'bearer', token_env: 'A2A_TOKEN' }))
      .toThrow(A2ACredentialError);
  });

  it('names the missing variable in the error', () => {
    expect(() => resolveAuthHeaders({ type: 'bearer', token_env: 'A2A_TOKEN' }))
      .toThrow(/A2A_TOKEN/);
  });
});

describe('InMemoryA2AServerRegistry', () => {
  it('round-trips an entry authored in camelCase', async () => {
    const registry = new InMemoryA2AServerRegistry();
    await registry.saveServer(VALID);

    expect(await registry.loadServer('research-service')).toMatchObject({
      id: 'research-service',
      agent_card_url: VALID.agentCardUrl,
    });
  });

  it('maps allowedEndpointHosts to the snake_case wire field', async () => {
    const registry = new InMemoryA2AServerRegistry();
    await registry.saveServer({ ...VALID, allowedEndpointHosts: ['rpc.example.com'] });

    expect((await registry.loadServer('research-service'))?.allowed_endpoint_hosts)
      .toEqual(['rpc.example.com']);
  });

  it('refuses to store an entry whose allowed endpoint host is not bare', async () => {
    const registry = new InMemoryA2AServerRegistry();

    await expect(registry.saveServer({ ...VALID, allowedEndpointHosts: ['https://rpc.example'] }))
      .rejects.toThrow(/bare hostname/);
    expect(await registry.loadServer('research-service')).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await new InMemoryA2AServerRegistry().loadServer('missing')).toBeNull();
  });

  it('refuses to store an entry that fails the guard', async () => {
    const registry = new InMemoryA2AServerRegistry();

    await expect(registry.saveServer({ ...VALID, agentCardUrl: 'https://127.0.0.1/card.json' }))
      .rejects.toThrow(/SSRF guard/);
    expect(await registry.loadServer('research-service')).toBeNull();
  });

  it('re-validates on read so a tampered row cannot be loaded', async () => {
    const registry = new InMemoryA2AServerRegistry();
    await registry.saveServer(VALID);

    const stored = (await registry.listServers())[0];
    stored.agent_card_url = 'http://169.254.169.254/latest/meta-data/';

    await expect(registry.loadServer('research-service')).rejects.toThrow(/SSRF guard/);
  });

  it('deletes an entry and reports whether it existed', async () => {
    const registry = new InMemoryA2AServerRegistry();
    await registry.saveServer(VALID);

    expect(await registry.deleteServer('research-service')).toBe(true);
    expect(await registry.deleteServer('research-service')).toBe(false);
  });
});
