/**
 * Cross-Tenant Isolation Tests
 *
 * The regression guard for the multi-tenancy model: a provider scoped to
 * tenant B must never see, load, or list tenant A's data.
 *
 * In the expand phase RLS is NOT yet enabled, so what most of these tests
 * exercise is the app-level `tenant_id` filter — the isolation mechanism in
 * force during the expand→enforce window. The two `RLS ...` tests switch to the
 * non-owner `cycgraph_app` role explicitly to validate the database-enforced
 * floor that `0018_tenancy_enforce` adds underneath the same assertions.
 *
 * NAMED CI GATE: run by explicit file path with ISOLATION_GATE=1. The first
 * test fails loud if that gate ever runs without a live database, so a broken
 * isolation guarantee cannot pass by silently skipping.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { DrizzleAgentRegistry } from '../src/drizzle-agent-registry.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { DrizzleOutcomeLedger } from '../src/drizzle-outcome-ledger.js';
import { createTenantScope } from '../src/tenant-scope.js';
import { tenants } from '../src/schema.js';
import { inArray, sql } from 'drizzle-orm';
import { createWorkflowState, createGraph } from '@cycgraph/orchestrator';
import type { WorkflowState } from '@cycgraph/orchestrator';
import type { SemanticFact } from '@cycgraph/memory';

it('fails loud under ISOLATION_GATE when no live database is configured', () => {
  if (process.env.ISOLATION_GATE === '1') {
    expect(isDatabaseAvailable()).toBe(true);
  }
});

describe.skipIf(!isDatabaseAvailable())('Cross-tenant isolation', () => {
  setupDatabaseTests();

  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();

  const providerA = new DrizzlePersistenceProvider({ tenant: { tenant_id: TENANT_A } });
  const providerB = new DrizzlePersistenceProvider({ tenant: { tenant_id: TENANT_B } });

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
    await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
  });

  function makeGraph(id?: string) {
    return createGraph({
      id,
      name: 'Tenant Graph',
      description: 'tenancy isolation fixture',
      nodes: [
        { id: 'start', type: 'agent', agent_id: 'agent-1', read_keys: ['*'], write_keys: ['*'] },
      ],
      edges: [],
      start_node: 'start',
      end_nodes: ['start'],
    });
  }

  function makeState(graphId: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
    return createWorkflowState({ workflow_id: graphId, goal: 'isolation', ...overrides });
  }

  function makeFact(content: string, tags: string[]): SemanticFact {
    return {
      id: randomUUID(),
      content,
      source_episode_ids: [],
      entity_ids: [],
      provenance: { source: 'system', confidence: 1, created_at: new Date() },
      valid_from: new Date(),
      access_count: 0,
      tags,
    };
  }

  it('hides tenant A\'s graph from a provider scoped to tenant B', async () => {
    const graph = makeGraph();
    await providerA.saveGraph(graph);

    expect(await providerA.loadGraph(graph.id)).not.toBeNull();
    expect(await providerB.loadGraph(graph.id)).toBeNull();
  });

  it('does not let tenant B overwrite tenant A\'s graph via a colliding id', async () => {
    const graph = makeGraph();
    await providerA.saveGraph(graph);
    expect((await providerA.loadGraph(graph.id))?.name).toBe('Tenant Graph');

    const hijack = { ...makeGraph(graph.id), name: 'Hijacked by B' };
    await providerB.saveGraph(hijack);

    expect((await providerA.loadGraph(graph.id))?.name).toBe('Tenant Graph');
    expect(await providerB.loadGraph(graph.id)).toBeNull();
  });

  it('hides tenant A\'s run and state from tenant B', async () => {
    const graph = makeGraph();
    await providerA.saveGraph(graph);
    const state = makeState(graph.id);
    await providerA.saveWorkflowSnapshot(state);

    expect(await providerA.loadWorkflowRun(state.run_id)).not.toBeNull();
    expect(await providerA.loadLatestWorkflowState(state.run_id)).not.toBeNull();

    expect(await providerB.loadWorkflowRun(state.run_id)).toBeNull();
    expect(await providerB.loadLatestWorkflowState(state.run_id)).toBeNull();
  });

  it('scopes listWorkflowRuns to the calling tenant', async () => {
    const graphA = makeGraph();
    await providerA.saveGraph(graphA);
    await providerA.saveWorkflowSnapshot(makeState(graphA.id));

    const graphB = makeGraph();
    await providerB.saveGraph(graphB);
    await providerB.saveWorkflowSnapshot(makeState(graphB.id));

    const runsA = await providerA.listWorkflowRuns();
    const runsB = await providerB.listWorkflowRuns();

    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    expect(runsA[0].id).not.toBe(runsB[0].id);
    expect(runsA.every((r) => r.id !== runsB[0].id)).toBe(true);
  });

  it('isolates agent config so it cannot leak across tenants', async () => {
    const registryA = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_A } });
    const registryB = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_B } });

    const agentId = await registryA.register({
      name: 'Research Agent',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      system_prompt: 'You research.',
      tools: [],
      permissions: { sandbox: false, read_keys: [], write_keys: [] },
    });

    expect(await registryA.loadAgent(agentId)).not.toBeNull();
    expect(await registryB.loadAgent(agentId)).toBeNull();
    expect(await registryB.listAgents()).toHaveLength(0);
  });

  it('allows the same agent name in a different tenant', async () => {
    const registryA = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_A } });
    const registryB = new DrizzleAgentRegistry({ tenant: { tenant_id: TENANT_B } });

    const config = {
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic' as const,
      tools: [],
      permissions: { sandbox: false, read_keys: [], write_keys: [] },
    };
    await registryA.register({ ...config, name: 'Research Agent', system_prompt: 'You research.' });

    await expect(
      registryB.register({ ...config, name: 'Research Agent', system_prompt: 'You also research.' }),
    ).resolves.toBeTruthy();
  });

  it('isolates memory facts, including tag-filtered retrieval', async () => {
    const storeA = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_A } });
    const storeB = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_B } });

    const fact = makeFact('Tenant A lesson: prefer approach X', ['lesson', 'candidate']);
    await storeA.putFact(fact);

    expect(await storeA.getFact(fact.id)).not.toBeNull();
    expect(await storeB.getFact(fact.id)).toBeNull();

    expect(await storeA.findFacts({ tags: ['lesson'] })).toHaveLength(1);
    expect(await storeB.findFacts({ tags: ['lesson'] })).toHaveLength(0);
  });

  it('isolates outcome-ledger stats and baseline across tenants', async () => {
    const ledgerA = new DrizzleOutcomeLedger({ tenant: { tenant_id: TENANT_A } });
    const ledgerB = new DrizzleOutcomeLedger({ tenant: { tenant_id: TENANT_B } });
    const factId = randomUUID();

    await ledgerA.recordOutcome({ run_id: randomUUID(), score: 0.9, fact_ids: [factId] });

    expect((await ledgerA.getFactStats(factId))?.trials).toBe(1);
    expect(await ledgerB.getFactStats(factId)).toBeNull();
    expect((await ledgerA.getBaseline()).runs).toBe(1);
    expect((await ledgerB.getBaseline()).runs).toBe(0);
  });

  it('hides cross-tenant rows via RLS when querying as the app role (0018)', async () => {
    const providerA = new DrizzlePersistenceProvider({ tenant: { tenant_id: TENANT_A } });
    const graph = makeGraph();
    await providerA.saveGraph(graph);

    const db = await getDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role cycgraph_app`);

      await tx.execute(sql`select set_config('app.tenant_id', ${TENANT_B}, true)`);
      const asB = await tx.execute(sql`select id from graphs where id = ${graph.id}`);
      expect(asB.rows).toHaveLength(0);

      await tx.execute(sql`select set_config('app.tenant_id', ${TENANT_A}, true)`);
      const asA = await tx.execute(sql`select id from graphs where id = ${graph.id}`);
      expect(asA.rows).toHaveLength(1);
    });
  });

  it('rejects via RLS WITH CHECK an insert that lacks a tenant context (0018)', async () => {
    const db = await getDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role cycgraph_app`);
        await tx.execute(
          sql`insert into agents (name, model, provider, system_prompt, tools, permissions)
              values ('x', 'm', 'anthropic', 'p', '[]'::jsonb, '{"sandbox":false,"read_keys":[],"write_keys":[]}'::jsonb)`,
        );
      }),
    ).rejects.toThrow();
  });

  it('wires a fully tenant-isolated adapter set via createTenantScope', async () => {
    const scopeA = createTenantScope({ tenant_id: TENANT_A });
    const scopeB = createTenantScope({ tenant_id: TENANT_B });

    const graph = makeGraph();
    await scopeA.persistence.saveGraph(graph);
    const state = makeState(graph.id);
    await scopeA.persistence.saveWorkflowSnapshot(state);
    await scopeA.memoryStore.putFact(makeFact('scope lesson', ['lesson']));

    expect(await scopeA.persistence.loadWorkflowRun(state.run_id)).not.toBeNull();
    expect(await scopeB.persistence.loadGraph(graph.id)).toBeNull();
    expect(await scopeB.persistence.loadWorkflowRun(state.run_id)).toBeNull();
    expect(await scopeB.memoryStore.findFacts({ tags: ['lesson'] })).toHaveLength(0);
    expect(await scopeA.memoryStore.findFacts({ tags: ['lesson'] })).toHaveLength(1);
  });

  it('keeps the seed tenant visible to an unscoped provider and hidden from scoped ones', async () => {
    const legacy = new DrizzlePersistenceProvider();
    const graph = makeGraph();
    await legacy.saveGraph(graph);

    expect(await legacy.loadGraph(graph.id)).not.toBeNull();
    expect(await providerA.loadGraph(graph.id)).toBeNull();
  });
});
