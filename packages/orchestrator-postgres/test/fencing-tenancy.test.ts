/**
 * Fenced-worker tenancy tests.
 *
 * Regression guard for tenant scoping of the fenced worker write path.
 *
 * The existing cross-tenant isolation suite constructs tenant-scoped adapters
 * DIRECTLY, so it never exercises `createFencedRunnerOptions` — which is the
 * ONLY place a worker can thread a job's tenant into its per-run writers. This
 * suite drives the real platform path a `WorkflowWorker` uses: enqueue →
 * dequeue a job for a tenant, build its writers via `createFencedRunnerOptions`,
 * then assert every state / event row lands under the job's tenant rather than
 * the seed-tenant column default.
 *
 * Before the fix, `createFencedRunnerOptions` passed only `{ fencing }`, so
 * these writes fell to `SEED_TENANT_ID` via the owner connection — collapsing
 * every hosted tenant's run history together.
 */

import { randomUUID } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkflowState } from '@cycgraph/orchestrator';
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
    // Cascade-deletes any rows this tenant still owns. Runs before setup's own
    // afterAll (closeDb) — hooks fire in registration order.
    const db = await getDb();
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  });

  /**
   * Insert a graph owned by TENANT_B, then enqueue + dequeue a job for it the
   * way the worker does. `dequeue` creates the tenant-stamped `workflow_runs`
   * row and stamps the fencing epoch, returning a fully-formed job.
   */
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

  test('state writes from the fenced path are stamped with the job tenant', async () => {
    const db = await getDb();
    const { job, runId, graphId } = await claimTenantJob();

    const opts = createFencedRunnerOptions(job);
    expect(opts.persistStateFn).toBeDefined();

    const state = createWorkflowState({ workflow_id: graphId, goal: 'fenced tenancy', run_id: runId });
    await opts.persistStateFn!(state);

    const rows = await db.select().from(workflow_states).where(eq(workflow_states.run_id, runId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
      expect(row.tenant_id).not.toBe(SEED_TENANT_ID);
    }
  });

  test('event appends from the fenced path are stamped with the job tenant', async () => {
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

  test('the fenced epoch check still fires under a tenant scope', async () => {
    const { job, runId, graphId } = await claimTenantJob();

    // A second claim on the same run bumps its epoch past the first job's token,
    // making that first job a stale (superseded) writer.
    await queue.enqueue({ type: 'start', tenant_id: TENANT_B, run_id: runId, graph_id: graphId });
    const secondJob = await queue.dequeue(`worker-${randomUUID()}`);
    expect(secondJob!.claim_epoch).toBeGreaterThan(job.claim_epoch!);

    const staleOpts = createFencedRunnerOptions(job);
    const state = createWorkflowState({ workflow_id: graphId, goal: 'stale', run_id: runId });

    // Fencing must reject the stale writer even though tenant scoping is now on
    // (the epoch read is tenant-filtered — a regression that broke the filter
    // would read zero rows and silently skip the check).
    await expect(staleOpts.persistStateFn!(state)).rejects.toThrow();
  });
});
