/**
 * DrizzleUsageRecorder Tests
 *
 * Integration tests for the Postgres-backed UsageRecorder: per-run cost/token
 * persistence, model_breakdown JSONB round-trips, numeric cost coercion, the
 * windowed cost-sum read path, and per-tenant scoping.
 *
 * Also exercises the public connection API (getDb caching, getPoolMetrics)
 * that every adapter is built on.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { getDb as getDbDirect, getPoolMetrics } from '../src/connection.js';
import { DrizzleUsageRecorder } from '../src/drizzle-usage.js';
import { graphs, workflow_runs, usage_records, tenants } from '../src/schema.js';
import type { UsageRecord } from '@cycgraph/orchestrator';

const EPOCH = new Date(0);
const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');

async function seedRunForTenant(tenantId?: string): Promise<{ runId: string; graphId: string }> {
  const db = await getDb();
  const graphId = randomUUID();
  const runId = randomUUID();
  const tenantValues = tenantId ? { tenant_id: tenantId } : {};

  await db.insert(graphs).values({
    id: graphId,
    ...tenantValues,
    name: 'usage-test-graph',
    definition: { nodes: [], edges: [] } as never,
  });
  await db.insert(workflow_runs).values({
    id: runId,
    ...tenantValues,
    graph_id: graphId,
    status: 'running',
  });

  return { runId, graphId };
}

async function seedApiKey(): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO api_keys (id, key_hash, name, permissions) VALUES (${id}, ${randomUUID()}, 'usage-test-key', '{}'::jsonb)`,
  );
  return id;
}

function makeRecord(overrides: Partial<UsageRecord> & Pick<UsageRecord, 'run_id' | 'graph_id'>): UsageRecord {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.05,
    duration_ms: 1200,
    ...overrides,
  };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleUsageRecorder', () => {
  setupDatabaseTests();

  const recorder = new DrizzleUsageRecorder();

  describe('saveUsageRecord', () => {
    it('persists token counts, duration, and coerced numeric cost', async () => {
      const { runId, graphId } = await seedRunForTenant();

      await recorder.saveUsageRecord(makeRecord({ run_id: runId, graph_id: graphId }));

      const db = await getDb();
      const rows = await db.select().from(usage_records).where(eq(usage_records.run_id, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0].input_tokens).toBe(100);
      expect(rows[0].output_tokens).toBe(50);
      expect(rows[0].duration_ms).toBe(1200);
      expect(Number(rows[0].cost_usd)).toBe(0.05);
    });

    it('persists model_breakdown as JSONB', async () => {
      const { runId, graphId } = await seedRunForTenant();
      const breakdown = {
        'claude-sonnet-4': { input_tokens: 80, output_tokens: 40, cost_usd: 0.04, calls: 2 },
        'gpt-4o-mini': { input_tokens: 20, output_tokens: 10, cost_usd: 0.01, calls: 1 },
      };

      await recorder.saveUsageRecord(makeRecord({ run_id: runId, graph_id: graphId, model_breakdown: breakdown }));

      const db = await getDb();
      const rows = await db.select().from(usage_records).where(eq(usage_records.run_id, runId));
      expect(rows[0].model_breakdown).toEqual(breakdown);
    });

    it('stores null model_breakdown when omitted', async () => {
      const { runId, graphId } = await seedRunForTenant();

      await recorder.saveUsageRecord(makeRecord({ run_id: runId, graph_id: graphId }));

      const db = await getDb();
      const rows = await db.select().from(usage_records).where(eq(usage_records.run_id, runId));
      expect(rows[0].model_breakdown).toBeNull();
    });

    it('stores null api_key_id when omitted and the provided one otherwise', async () => {
      const withoutKey = await seedRunForTenant();
      const withKey = await seedRunForTenant();
      const apiKeyId = await seedApiKey();

      await recorder.saveUsageRecord(makeRecord({ run_id: withoutKey.runId, graph_id: withoutKey.graphId }));
      await recorder.saveUsageRecord(
        makeRecord({ run_id: withKey.runId, graph_id: withKey.graphId, api_key_id: apiKeyId }),
      );

      const db = await getDb();
      const noKeyRows = await db.select().from(usage_records).where(eq(usage_records.run_id, withoutKey.runId));
      const keyRows = await db.select().from(usage_records).where(eq(usage_records.run_id, withKey.runId));
      expect(noKeyRows[0].api_key_id).toBeNull();
      expect(keyRows[0].api_key_id).toBe(apiKeyId);
    });
  });

  describe('sumCostSince', () => {
    it('returns 0 when no records exist in the window', async () => {
      const total = await recorder.sumCostSince(EPOCH);

      expect(total).toBe(0);
    });

    it('sums cost across all records at or after the cutoff', async () => {
      const first = await seedRunForTenant();
      const second = await seedRunForTenant();

      await recorder.saveUsageRecord(makeRecord({ run_id: first.runId, graph_id: first.graphId, cost_usd: 0.25 }));
      await recorder.saveUsageRecord(makeRecord({ run_id: second.runId, graph_id: second.graphId, cost_usd: 0.75 }));

      const total = await recorder.sumCostSince(EPOCH);
      expect(total).toBe(1);
    });

    it('excludes records created before the cutoff', async () => {
      const { runId, graphId } = await seedRunForTenant();
      await recorder.saveUsageRecord(makeRecord({ run_id: runId, graph_id: graphId, cost_usd: 0.5 }));

      const total = await recorder.sumCostSince(FAR_FUTURE);
      expect(total).toBe(0);
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

    it('stamps the recorder tenant on saved rows', async () => {
      const { runId, graphId } = await seedRunForTenant(TENANT_A);
      const recorderA = new DrizzleUsageRecorder({ tenant: { tenant_id: TENANT_A } });

      await recorderA.saveUsageRecord(makeRecord({ run_id: runId, graph_id: graphId }));

      const db = await getDb();
      const rows = await db.select().from(usage_records).where(eq(usage_records.run_id, runId));
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('sums only the recorder tenant\'s cost', async () => {
      const runA = await seedRunForTenant(TENANT_A);
      const runB = await seedRunForTenant(TENANT_B);
      const recorderA = new DrizzleUsageRecorder({ tenant: { tenant_id: TENANT_A } });
      const recorderB = new DrizzleUsageRecorder({ tenant: { tenant_id: TENANT_B } });

      await recorderA.saveUsageRecord(makeRecord({ run_id: runA.runId, graph_id: runA.graphId, cost_usd: 0.3 }));
      await recorderB.saveUsageRecord(makeRecord({ run_id: runB.runId, graph_id: runB.graphId, cost_usd: 0.9 }));

      expect(await recorderA.sumCostSince(EPOCH)).toBe(0.3);
      expect(await recorderB.sumCostSince(EPOCH)).toBe(0.9);
    });
  });
});

describe.skipIf(!isDatabaseAvailable())('connection', () => {
  setupDatabaseTests();

  describe('getDb', () => {
    it('returns the same cached Drizzle instance across calls', async () => {
      const first = await getDbDirect();
      const second = await getDbDirect();

      expect(first).toBe(second);
    });
  });

  describe('getPoolMetrics', () => {
    it('reports numeric pool counts once the pool is initialised', async () => {
      await getDbDirect();

      const metrics = getPoolMetrics();
      expect(typeof metrics.totalCount).toBe('number');
      expect(typeof metrics.idleCount).toBe('number');
      expect(typeof metrics.waitingCount).toBe('number');
    });
  });
});
