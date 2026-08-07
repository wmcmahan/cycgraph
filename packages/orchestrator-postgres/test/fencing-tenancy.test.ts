/**
 * Fenced-worker tenancy tests.
 *
 * Regression guard for tenant scoping of the fenced worker write path.
 *
 * The cross-tenant isolation suite constructs tenant-scoped adapters directly,
 * so it never exercises `createFencedRunnerOptions` — the ONLY place a worker
 * threads a job's tenant into its per-run writers. This suite drives the real
 * platform path: enqueue → dequeue a job for a tenant, build its writers via
 * `createFencedRunnerOptions`, then assert every state / event row lands under
 * the job's tenant rather than the seed-tenant column default.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkflowState, WorkflowJobSchema } from '@cycgraph/orchestrator';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleWorkflowQueue } from '../src/drizzle-queue.js';
import { createFencedRunnerOptions } from '../src/fencing.js';
import { SEED_TENANT_ID } from '../src/constants.js';
import {
  tenants,
  graphs,
  workflow_states,
  workflow_events,
} from '../src/schema.js';

describe('createFencedRunnerOptions', () => {
  it('returns empty options when the job carries no fencing epoch', () => {
    const job = WorkflowJobSchema.parse({
      id: randomUUID(),
      type: 'start',
      tenant_id: randomUUID(),
      run_id: randomUUID(),
      graph_id: randomUUID(),
    });

    const opts = createFencedRunnerOptions(job);

    expect(opts).toEqual({});
  });

  it('builds fenced writers when the job carries an epoch but no tenant', () => {
    const job = WorkflowJobSchema.parse({
      id: randomUUID(),
      type: 'start',
      run_id: randomUUID(),
      graph_id: randomUUID(),
      claim_epoch: 1,
    });

    const opts = createFencedRunnerOptions(job);

    expect(opts.persistState).toBeDefined();
    expect(opts.eventLog).toBeDefined();
  });

  it('builds fenced writers when the job carries both an epoch and a tenant', () => {
    const job = WorkflowJobSchema.parse({
      id: randomUUID(),
      type: 'start',
      tenant_id: randomUUID(),
      run_id: randomUUID(),
      graph_id: randomUUID(),
      claim_epoch: 2,
    });

    const opts = createFencedRunnerOptions(job);

    expect(opts.persistState).toBeDefined();
    expect(opts.eventLog).toBeDefined();
  });
});

describe.skipIf(!isDatabaseAvailable())('Fenced worker tenancy', () => {
  setupDatabaseTests();

  const TENANT_B = randomUUID();
  const queue = new DrizzleWorkflowQueue();

  beforeAll(async () => {
    const db = await getDb();
    await db
      .insert(tenants)
      .values({ id: TENANT_B, slug: `b-${TENANT_B}`, name: 'Tenant B' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    const db = await getDb();
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  });

  async function claimTenantJob() {
    const db = await getDb();
    const graphId = randomUUID();
    const runId = randomUUID();
    await db
      .insert(graphs)
      .values({
        id: graphId,
        tenant_id: TENANT_B,
        name: 'fenced-tenancy-graph',
        definition: { nodes: [], edges: [] } as never,
      })
      .onConflictDoNothing();

    await queue.enqueue({ type: 'start', tenant_id: TENANT_B, run_id: runId, graph_id: graphId });
    const job = await queue.dequeue(`worker-${randomUUID()}`);
    expect(job).not.toBeNull();
    expect(job!.tenant_id).toBe(TENANT_B);
    return { job: job!, runId, graphId };
  }

  it('stamps state writes from the fenced path with the job tenant', async () => {
    const db = await getDb();
    const { job, runId, graphId } = await claimTenantJob();

    const opts = createFencedRunnerOptions(job);
    expect(opts.persistState).toBeDefined();

    const state = createWorkflowState({ workflow_id: graphId, goal: 'fenced tenancy', run_id: runId });
    await opts.persistState!(state);

    const rows = await db.select().from(workflow_states).where(eq(workflow_states.run_id, runId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
      expect(row.tenant_id).not.toBe(SEED_TENANT_ID);
    }
  });

  it('stamps event appends from the fenced path with the job tenant', async () => {
    const db = await getDb();
    const { job, runId } = await claimTenantJob();

    const opts = createFencedRunnerOptions(job);
    expect(opts.eventLog).toBeDefined();

    await opts.eventLog!.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
    await opts.eventLog!.append({ run_id: runId, sequence_id: 1, event_type: 'node_started' });

    const rows = await db.select().from(workflow_events).where(eq(workflow_events.run_id, runId));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
      expect(row.tenant_id).not.toBe(SEED_TENANT_ID);
    }
  });

  it('rejects a stale fenced writer even under a tenant scope', async () => {
    const { job, runId, graphId } = await claimTenantJob();

    await queue.enqueue({ type: 'start', tenant_id: TENANT_B, run_id: runId, graph_id: graphId });
    const secondJob = await queue.dequeue(`worker-${randomUUID()}`);
    expect(secondJob!.claim_epoch).toBeGreaterThan(job.claim_epoch!);

    const staleOpts = createFencedRunnerOptions(job);
    const state = createWorkflowState({ workflow_id: graphId, goal: 'stale', run_id: runId });

    await expect(staleOpts.persistState!(state)).rejects.toThrow();
  });
});
