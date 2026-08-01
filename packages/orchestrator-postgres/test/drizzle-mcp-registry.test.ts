/**
 * DrizzleMCPServerRegistry Tests
 *
 * Integration tests for the Postgres-backed MCP server registry. Entries pass
 * through MCPServerEntrySchema on BOTH save and load — the trust boundary that
 * enforces the stdio-command allowlist and the URL SSRF guard. These tests
 * cover camelCase authoring → snake_case storage, allowlist/SSRF rejection at
 * the write boundary, re-validation on read, the CRUD lifecycle, and per-tenant
 * scoping including the cross-tenant id-collision no-op.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleMCPServerRegistry } from '../src/drizzle-mcp-registry.js';
import { mcp_servers, tenants } from '../src/schema.js';
import type { MCPServerConfig } from '@cycgraph/orchestrator';

function stdioConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: `svc-${randomUUID().slice(0, 8)}`,
    name: 'Filesystem Server',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    ...overrides,
  } as MCPServerConfig;
}

function httpConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: `svc-${randomUUID().slice(0, 8)}`,
    name: 'Remote Server',
    transport: { type: 'http', url: 'https://mcp.example.com/sse' },
    ...overrides,
  } as MCPServerConfig;
}

describe.skipIf(!isDatabaseAvailable())('DrizzleMCPServerRegistry', () => {
  setupDatabaseTests();

  const registry = new DrizzleMCPServerRegistry();

  describe('saveServer', () => {
    it('round-trips a stdio server and remaps camelCase authoring to snake_case', async () => {
      const config = stdioConfig({
        id: 'files',
        description: 'local files',
        allowedAgents: ['agent-1', 'agent-2'],
        timeoutMs: 45_000,
      });

      await registry.saveServer(config);

      const loaded = await registry.loadServer('files');
      expect(loaded).toEqual({
        id: 'files',
        name: 'Filesystem Server',
        description: 'local files',
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        allowed_agents: ['agent-1', 'agent-2'],
        timeout_ms: 45_000,
      });
    });

    it('defaults timeout_ms and omits an unset description on load', async () => {
      await registry.saveServer(httpConfig({ id: 'remote' }));

      const loaded = await registry.loadServer('remote');
      expect(loaded!.timeout_ms).toBe(30_000);
      expect(loaded!.description).toBeUndefined();
      expect(loaded!.allowed_agents).toBeUndefined();
    });

    it('upserts an existing server in place', async () => {
      await registry.saveServer(httpConfig({ id: 'up', name: 'Original' }));
      await registry.saveServer(httpConfig({ id: 'up', name: 'Updated', timeoutMs: 5_000 }));

      const loaded = await registry.loadServer('up');
      expect(loaded!.name).toBe('Updated');
      expect(loaded!.timeout_ms).toBe(5_000);
      expect(await registry.listServers()).toHaveLength(1);
    });

    it('rejects a stdio command outside the allowlist', async () => {
      const config = stdioConfig({ id: 'evil', transport: { type: 'stdio', command: 'bash', args: ['-c', 'rm -rf /'] } as never });

      await expect(registry.saveServer(config)).rejects.toThrow();

      const db = await getDb();
      const rows = await db.select().from(mcp_servers).where(eq(mcp_servers.id, 'evil'));
      expect(rows).toHaveLength(0);
    });

    it('rejects an http transport URL pointing at a private/loopback host (SSRF guard)', async () => {
      const config = httpConfig({ id: 'ssrf', transport: { type: 'http', url: 'http://localhost:8080/mcp' } });

      await expect(registry.saveServer(config)).rejects.toThrow();
    });

    it('rejects a non-http(s) transport URL', async () => {
      const config = httpConfig({ id: 'proto', transport: { type: 'http', url: 'ftp://mcp.example.com/x' } as never });

      await expect(registry.saveServer(config)).rejects.toThrow();
    });
  });

  describe('loadServer', () => {
    it('returns null for an unknown id', async () => {
      const loaded = await registry.loadServer('missing');

      expect(loaded).toBeNull();
    });

    it('re-validates on read and rejects a row that bypassed the write guard', async () => {
      const db = await getDb();
      await db.insert(mcp_servers).values({
        id: 'smuggled',
        name: 'Smuggled',
        transport: { type: 'stdio', command: 'rm', args: ['-rf', '/'] } as never,
        timeout_ms: 30_000,
      });

      await expect(registry.loadServer('smuggled')).rejects.toThrow();
    });
  });

  describe('listServers', () => {
    it('returns all registered servers in snake_case', async () => {
      await registry.saveServer(stdioConfig({ id: 'a' }));
      await registry.saveServer(httpConfig({ id: 'b' }));

      const list = await registry.listServers();
      expect(list).toHaveLength(2);
      expect(new Set(list.map(s => s.id))).toEqual(new Set(['a', 'b']));
    });

    it('returns an empty array when no servers exist', async () => {
      const list = await registry.listServers();

      expect(list).toEqual([]);
    });
  });

  describe('deleteServer', () => {
    it('returns true and removes an existing server', async () => {
      await registry.saveServer(httpConfig({ id: 'gone' }));

      const deleted = await registry.deleteServer('gone');

      expect(deleted).toBe(true);
      expect(await registry.loadServer('gone')).toBeNull();
    });

    it('returns false for an unknown id', async () => {
      const deleted = await registry.deleteServer('never');

      expect(deleted).toBe(false);
    });
  });

  describe('tenant scoping', () => {
    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();

    beforeAll(async () => {
      const db = await getDb();
      await db
        .insert(tenants)
        .values([
          { id: TENANT_A, slug: `a-${TENANT_A}`, name: 'Tenant A' },
          { id: TENANT_B, slug: `b-${TENANT_B}`, name: 'Tenant B' },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      const db = await getDb();
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
      await db.delete(tenants).where(eq(tenants.id, TENANT_B));
    });

    it('stamps the registry tenant on saved servers', async () => {
      const registryA = new DrizzleMCPServerRegistry({ tenant: { tenant_id: TENANT_A } });
      await registryA.saveServer(httpConfig({ id: 'a-only' }));

      const db = await getDb();
      const rows = await db.select().from(mcp_servers).where(eq(mcp_servers.id, 'a-only'));
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('does not load or list another tenant\'s server', async () => {
      const registryA = new DrizzleMCPServerRegistry({ tenant: { tenant_id: TENANT_A } });
      const registryB = new DrizzleMCPServerRegistry({ tenant: { tenant_id: TENANT_B } });
      await registryA.saveServer(httpConfig({ id: 'a-scoped' }));

      expect(await registryB.loadServer('a-scoped')).toBeNull();
      expect(await registryB.listServers()).toHaveLength(0);
    });

    it('does not clobber another tenant\'s server on an id collision (setWhere guard)', async () => {
      const registryA = new DrizzleMCPServerRegistry({ tenant: { tenant_id: TENANT_A } });
      const registryB = new DrizzleMCPServerRegistry({ tenant: { tenant_id: TENANT_B } });
      await registryA.saveServer(httpConfig({ id: 'shared', name: 'A owns this' }));

      await registryB.saveServer(httpConfig({ id: 'shared', name: 'B tries to take it' }));

      expect((await registryA.loadServer('shared'))!.name).toBe('A owns this');
      expect(await registryB.loadServer('shared')).toBeNull();
    });
  });
});
