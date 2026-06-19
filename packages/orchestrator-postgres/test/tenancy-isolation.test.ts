/**
 * Cross-Tenant Isolation Tests
 *
 * The regression guard for the multi-tenancy model: a provider scoped to
 * tenant B must never see, load, or list tenant A's data.
 *
 * NOTE: in the expand phase RLS is NOT yet enabled, so what these tests
 * exercise is the **app-level `tenant_id` filter** — which is exactly the
 * isolation mechanism in force during the expand→enforce window. Once
 * `0018_tenancy_enforce` lands, RLS becomes a second, database-enforced floor
 * underneath these same assertions, so the tests stay valid (and get stronger).
 */

import { randomUUID } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
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

// Release-gate guard (CI `tenant-isolation-gate` sets ISOLATION_GATE=1): the
// DB-backed isolation suite below MUST actually execute against a real Postgres
// with RLS applied — fail loudly here rather than let the suite silently skip
// (which would let a broken isolation guarantee pass the gate). A no-op locally.
test('isolation gate runs against a live database', () => {
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
    // Cascade-deletes any rows these tenants still own. Runs before setup's
    // own afterAll (closeDb) — hooks fire in registration order.
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

  test('tenant B cannot load tenant A\'s graph', async () => {
    const graph = makeGraph();
    await providerA.saveGraph(graph);

    expect(await providerA.loadGraph(graph.id)).not.toBeNull();
    // Same id, different tenant — must be invisible.
    expect(await providerB.loadGraph(graph.id)).toBeNull();
  });

  test('tenant B cannot load tenant A\'s run or state', async () => {
    const graph = makeGraph();
    await providerA.saveGraph(graph);
    const state = makeState(graph.id);
    await providerA.saveWorkflowSnapshot(state);

    expect(await providerA.loadWorkflowRun(state.run_id)).not.toBeNull();
    expect(await providerA.loadLatestWorkflowState(state.run_id)).not.toBeNull();

    expect(await providerB.loadWorkflowRun(state.run_id)).toBeNull();
    expect(await providerB.loadLatestWorkflowState(state.run_id)).toBeNull();
  });

  test('listWorkflowRuns is scoped to the calling tenant', async () => {
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
    // Neither list contains the other tenant's run.
    expect(runsA.every((r) => r.id !== runsB[0].id)).toBe(true);
  });

  test('agent registry is tenant-isolated (config must not leak)', async () => {
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

    // Same agent name is allowed in a different tenant (per-tenant uniqueness).
    await expect(
      registryB.register({
        name: 'Research Agent',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        system_prompt: 'You also research.',
        tools: [],
        permissions: { sandbox: false, read_keys: [], write_keys: [] },
      }),
    ).resolves.toBeTruthy();
  });

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

  test('memory facts (lessons) are tenant-isolated, including tag retrieval', async () => {
    const storeA = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_A } });
    const storeB = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_B } });

    const fact = makeFact('Tenant A lesson: prefer approach X', ['lesson', 'candidate']);
    await storeA.putFact(fact);

    expect(await storeA.getFact(fact.id)).not.toBeNull();
    expect(await storeB.getFact(fact.id)).toBeNull();

    // The tag-filtered retrieval path is exactly how lessons get injected into
    // prompts — it must never surface another tenant's facts.
    expect(await storeA.findFacts({ tags: ['lesson'] })).toHaveLength(1);
    expect(await storeB.findFacts({ tags: ['lesson'] })).toHaveLength(0);
  });

  test('outcome-ledger stats/baseline are tenant-isolated (gate cannot be cross-moved)', async () => {
    const ledgerA = new DrizzleOutcomeLedger({ tenant: { tenant_id: TENANT_A } });
    const ledgerB = new DrizzleOutcomeLedger({ tenant: { tenant_id: TENANT_B } });
    const factId = randomUUID();

    await ledgerA.recordOutcome({ run_id: randomUUID(), score: 0.9, fact_ids: [factId] });

    // Tenant A's run evidence must be invisible to tenant B's gate.
    expect((await ledgerA.getFactStats(factId))?.trials).toBe(1);
    expect(await ledgerB.getFactStats(factId)).toBeNull();
    expect((await ledgerA.getBaseline()).runs).toBe(1);
    expect((await ledgerB.getBaseline()).runs).toBe(0);
  });

  test('RLS hides cross-tenant rows when querying as the app role (0018)', async () => {
    // Seed a graph for tenant A. In CI (no APP_DATABASE_URL) this writes as the
    // owner, which bypasses non-forced RLS — that's the point: the *enforcement*
    // is validated below by switching to the RLS-subject role explicitly.
    const providerA = new DrizzlePersistenceProvider({ tenant: { tenant_id: TENANT_A } });
    const graph = makeGraph();
    await providerA.saveGraph(graph);

    const db = await getDb();
    await db.transaction(async (tx) => {
      // Become the non-owner, RLS-subject role for this transaction only.
      // (The DB superuser can SET ROLE to any role; resets at commit.)
      await tx.execute(sql`set local role cycgraph_app`);

      // Raw query, NO app-level tenant filter — so this isolates *only* if the
      // RLS policy is doing the work. Under tenant B's GUC, A's row is hidden.
      await tx.execute(sql`select set_config('app.tenant_id', ${TENANT_B}, true)`);
      const asB = await tx.execute(sql`select id from graphs where id = ${graph.id}`);
      expect(asB.rows).toHaveLength(0);

      // Under tenant A's GUC, the same row is visible.
      await tx.execute(sql`select set_config('app.tenant_id', ${TENANT_A}, true)`);
      const asA = await tx.execute(sql`select id from graphs where id = ${graph.id}`);
      expect(asA.rows).toHaveLength(1);
    });
  });

  test('RLS WITH CHECK rejects an insert that lacks a tenant context (0018)', async () => {
    const db = await getDb();
    // As the app role with NO app.tenant_id set, current_setting is NULL, so the
    // WITH CHECK fails — an unscoped write cannot silently land anywhere.
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

  test('createTenantScope wires a fully tenant-isolated adapter set', async () => {
    const scopeA = createTenantScope({ tenant_id: TENANT_A });
    const scopeB = createTenantScope({ tenant_id: TENANT_B });

    const graph = makeGraph();
    await scopeA.persistence.saveGraph(graph);
    const state = makeState(graph.id);
    await scopeA.persistence.saveWorkflowSnapshot(state);
    await scopeA.memoryStore.putFact(makeFact('scope lesson', ['lesson']));

    // Adapters built by the factory isolate exactly like hand-constructed ones.
    expect(await scopeA.persistence.loadWorkflowRun(state.run_id)).not.toBeNull();
    expect(await scopeB.persistence.loadGraph(graph.id)).toBeNull();
    expect(await scopeB.persistence.loadWorkflowRun(state.run_id)).toBeNull();
    expect(await scopeB.memoryStore.findFacts({ tags: ['lesson'] })).toHaveLength(0);
    expect(await scopeA.memoryStore.findFacts({ tags: ['lesson'] })).toHaveLength(1);
  });

  test('a single-tenant (unscoped) provider still works and sees the seed tenant', async () => {
    // Backward-compat: no tenant option → seed-tenant default, no filter.
    const legacy = new DrizzlePersistenceProvider();
    const graph = makeGraph();
    await legacy.saveGraph(graph);
    expect(await legacy.loadGraph(graph.id)).not.toBeNull();
    // The tenant-scoped providers must not see the seed tenant's row.
    expect(await providerA.loadGraph(graph.id)).toBeNull();
  });
});
