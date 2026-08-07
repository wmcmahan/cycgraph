/**
 * DrizzleAgentRegistry Tests
 *
 * Integration tests for the Postgres-backed AgentRegistry: auto-UUID
 * registration, camelCase authoring → snake_case storage remap, schema
 * defaults, load/update/delete lifecycle, list pagination, the permission
 * ceiling round-trip, and per-tenant scoping.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleAgentRegistry } from '../src/drizzle-agent-registry.js';
import { agents, tenants } from '../src/schema.js';
import type { AgentRegistryConfig } from '@cycgraph/orchestrator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeConfig(overrides: Partial<AgentRegistryConfig> = {}): AgentRegistryConfig {
  return {
    name: `agent-${randomUUID()}`,
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    systemPrompt: 'You are a research specialist.',
    tools: [{ type: 'mcp', serverId: 'web-search' }],
    permissions: { sandbox: false, readKeys: ['goal'], writeKeys: ['research_notes'] },
    ...overrides,
  } as AgentRegistryConfig;
}

describe.skipIf(!isDatabaseAvailable())('DrizzleAgentRegistry', () => {
  setupDatabaseTests();

  const registry = new DrizzleAgentRegistry();

  describe('register', () => {
    it('auto-generates a UUID and returns it', async () => {
      const id = await registry.register(makeConfig());

      expect(id).toMatch(UUID_RE);
    });

    it('remaps camelCase authoring fields to snake_case storage', async () => {
      const id = await registry.register(
        makeConfig({
          systemPrompt: 'Remap me.',
          maxSteps: 7,
          permissions: { sandbox: true, readKeys: ['goal', 'a'], writeKeys: ['b'] },
        }),
      );

      const entry = await registry.loadAgent(id);
      expect(entry!.system_prompt).toBe('Remap me.');
      expect(entry!.max_steps).toBe(7);
      expect(entry!.permissions).toEqual({ sandbox: true, read_keys: ['goal', 'a'], write_keys: ['b'] });
    });

    it('applies schema defaults for temperature, max_steps, and description', async () => {
      const id = await registry.register(makeConfig());

      const entry = await registry.loadAgent(id);
      expect(entry!.temperature).toBe(0.7);
      expect(entry!.max_steps).toBe(10);
      expect(entry!.description).toBeNull();
    });

    it('persists tools as declared', async () => {
      const id = await registry.register(
        makeConfig({ tools: [{ type: 'mcp', serverId: 'web-search' }, { type: 'builtin', name: 'save_to_memory' }] }),
      );

      const entry = await registry.loadAgent(id);
      expect(entry!.tools).toEqual([
        { type: 'mcp', server_id: 'web-search' },
        { type: 'builtin', name: 'save_to_memory' },
      ]);
    });

    it('round-trips the permission ceiling including budget_usd', async () => {
      const id = await registry.register(
        makeConfig({
          permissions: { sandbox: true, readKeys: ['goal'], writeKeys: ['out'], budgetUsd: 2.5 },
        }),
      );

      const entry = await registry.loadAgent(id);
      expect(entry!.permissions).toEqual({
        sandbox: true,
        read_keys: ['goal'],
        write_keys: ['out'],
        budget_usd: 2.5,
      });
    });

    it('round-trips provider_options and model_preference when supplied', async () => {
      const id = await registry.register(
        makeConfig({ providerOptions: { anthropic: { thinking: true } }, modelPreference: 'high' }),
      );

      const entry = await registry.loadAgent(id);
      expect(entry!.provider_options).toEqual({ anthropic: { thinking: true } });
      expect(entry!.model_preference).toBe('high');
    });
  });

  describe('registerAgent', () => {
    it('is a working deprecated alias for register', async () => {
      const id = await registry.registerAgent(makeConfig());

      const entry = await registry.loadAgent(id);
      expect(entry!.id).toBe(id);
    });
  });

  describe('loadAgent', () => {
    it('returns null for an unknown id', async () => {
      const entry = await registry.loadAgent(randomUUID());

      expect(entry).toBeNull();
    });

    it('returns null for a non-uuid id instead of a Postgres type error', async () => {
      const entry = await registry.loadAgent('research-brain');

      expect(entry).toBeNull();
    });
  });

  describe('updateAgent', () => {
    it('updates only the provided fields and leaves others intact', async () => {
      const id = await registry.register(makeConfig({ model: 'old-model', maxSteps: 3 }));

      await registry.updateAgent(id, { model: 'new-model' });

      const entry = await registry.loadAgent(id);
      expect(entry!.model).toBe('new-model');
      expect(entry!.max_steps).toBe(3);
    });

    it('remaps camelCase updates to snake_case columns', async () => {
      const id = await registry.register(makeConfig());

      await registry.updateAgent(id, { systemPrompt: 'Updated prompt.', maxSteps: 12 });

      const entry = await registry.loadAgent(id);
      expect(entry!.system_prompt).toBe('Updated prompt.');
      expect(entry!.max_steps).toBe(12);
    });

    it('no-ops for a non-uuid id instead of a Postgres type error', async () => {
      await expect(registry.updateAgent('research-brain', { model: 'new-model' })).resolves.toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('returns all registered agents newest-first', async () => {
      const firstId = await registry.register(makeConfig());
      const secondId = await registry.register(makeConfig());

      const list = await registry.listAgents();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(secondId);
      expect(list[1].id).toBe(firstId);
    });

    it('caps results with limit and skips with offset', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 3; i++) ids.add(await registry.register(makeConfig()));

      const page1 = await registry.listAgents({ limit: 2, offset: 0 });
      const page2 = await registry.listAgents({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      const paged = new Set([...page1, ...page2].map(a => a.id));
      expect(paged).toEqual(ids);
    });
  });

  describe('deleteAgent', () => {
    it('returns true and removes an existing agent', async () => {
      const id = await registry.register(makeConfig());

      const deleted = await registry.deleteAgent(id);

      expect(deleted).toBe(true);
      expect(await registry.loadAgent(id)).toBeNull();
    });

    it('returns false for an unknown id', async () => {
      const deleted = await registry.deleteAgent(randomUUID());

      expect(deleted).toBe(false);
    });

    it('returns false for a non-uuid id instead of a Postgres type error', async () => {
      const deleted = await registry.deleteAgent('research-brain');

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

    it('stamps the registry tenant on registered agents', async () => {
      const registryA = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_A } });
      const id = await registryA.register(makeConfig());

      const db = await getDb();
      const rows = await db.select().from(agents).where(eq(agents.id, id));
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('does not load or list another tenant\'s agents', async () => {
      const registryA = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_A } });
      const registryB = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_B } });
      const idA = await registryA.register(makeConfig());

      expect(await registryB.loadAgent(idA)).toBeNull();
      expect(await registryB.listAgents()).toHaveLength(0);
    });

    it('does not delete another tenant\'s agent', async () => {
      const registryA = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_A } });
      const registryB = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_B } });
      const idA = await registryA.register(makeConfig());

      expect(await registryB.deleteAgent(idA)).toBe(false);
      expect(await registryA.loadAgent(idA)).not.toBeNull();
    });
  });
});
