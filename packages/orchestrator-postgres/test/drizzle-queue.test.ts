/**
 * DrizzleWorkflowQueue Tests
 *
 * Integration tests for the Postgres-backed job queue: atomic claim
 * semantics (FOR UPDATE SKIP LOCKED), visibility-timeout reclaim, the
 * ack/nack/release lifecycle, and run fencing epochs.
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleWorkflowQueue } from '../src/drizzle-queue.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { createFencedRunnerOptions } from '../src/fencing.js';
import { graphs, workflow_jobs } from '../src/schema.js';
import { createWorkflowState, StaleClaimError } from '@cycgraph/orchestrator';
import { eq } from 'drizzle-orm';

describe.skipIf(!isDatabaseAvailable())('DrizzleWorkflowQueue', () => {
  setupDatabaseTests();

  // Zero retry backoff so nack→re-dequeue is immediate across the mechanics
  // tests below. Retry backoff has its own dedicated test.
  const queue = new DrizzleWorkflowQueue({ retryBackoffMs: 0 });

  async function seedGraph(): Promise<string> {
    const db = await getDb();
    const graphId = crypto.randomUUID();
    await db.insert(graphs).values({
      id: graphId,
      name: 'queue-test-graph',
      definition: {
        id: graphId,
        name: 'queue-test-graph',
        nodes: [],
        edges: [],
        start_node: 'a',
        end_nodes: ['a'],
      },
    });
    return graphId;
  }

  test('enqueue → dequeue claims highest priority first and stamps claim_epoch', async () => {
    const graphId = await seedGraph();
    const lowPriority = crypto.randomUUID();
    const highPriority = crypto.randomUUID();

    await queue.enqueue({ type: 'start', run_id: lowPriority, graph_id: graphId, priority: 10 });
    await queue.enqueue({ type: 'start', run_id: highPriority, graph_id: graphId, priority: 1 });

    const job = await queue.dequeue('worker-1');
    expect(job).not.toBeNull();
    expect(job!.run_id).toBe(highPriority);
    expect(job!.status).toBe('active');
    expect(job!.worker_id).toBe('worker-1');
    expect(job!.attempt).toBe(1);
    expect(job!.claim_epoch).toBe(1);
    expect(job!.visible_at).toBeInstanceOf(Date);
  });

  test('dequeue creates the run row so event appends satisfy the FK', async () => {
    const graphId = await seedGraph();
    const runId = crypto.randomUUID();
    await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
    await queue.dequeue('worker-1');

    // The run row exists — an event append (FK on run_id) must succeed.
    const writer = new DrizzleEventLogWriter();
    await expect(
      writer.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' }),
    ).resolves.toBeUndefined();
  });

  test('each claim of the same run bumps the fencing epoch', async () => {
    const graphId = await seedGraph();
    const runId = crypto.randomUUID();

    await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
    const first = await queue.dequeue('worker-1');
    expect(first!.claim_epoch).toBe(1);

    // Simulate a reclaim + second claim of the same run.
    await queue.nack(first!.id, 'simulated crash');
    const second = await queue.dequeue('worker-2');
    expect(second!.run_id).toBe(runId);
    expect(second!.claim_epoch).toBe(2);
  });

  test('a job claimed by one worker is not claimable by another', async () => {
    const graphId = await seedGraph();
    await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });

    const job1 = await queue.dequeue('worker-1');
    const job2 = await queue.dequeue('worker-2');
    expect(job1).not.toBeNull();
    expect(job2).toBeNull();
  });

  test('concurrent dequeues never claim the same job (SKIP LOCKED)', async () => {
    const graphId = await seedGraph();
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
    }

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) => queue.dequeue(`worker-${i}`)),
    );
    const claimed = claims.filter((j): j is NonNullable<typeof j> => j !== null);
    expect(claimed).toHaveLength(5);
    const ids = new Set(claimed.map(j => j.id));
    expect(ids.size).toBe(5);
  });

  test('nack before max_attempts returns job to waiting; at max_attempts dead-letters', async () => {
    const graphId = await seedGraph();
    const runId = crypto.randomUUID();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: graphId,
      max_attempts: 2,
    });

    await queue.dequeue('worker-1');
    await queue.nack(jobId, 'boom 1');
    expect((await queue.getJob(jobId))!.status).toBe('waiting');

    await queue.dequeue('worker-1');
    await queue.nack(jobId, 'boom 2');
    const dead = await queue.getJob(jobId);
    expect(dead!.status).toBe('dead_letter');
    expect(dead!.last_error).toBe('boom 2');

    const depth = await queue.getQueueDepth();
    expect(depth.dead_letter).toBe(1);
  });

  test('ack completes; release pauses (not re-claimable)', async () => {
    const graphId = await seedGraph();
    const ackId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
    await queue.dequeue('worker-1');
    await queue.ack(ackId);
    expect((await queue.getJob(ackId))!.status).toBe('completed');

    const relId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
    await queue.dequeue('worker-1');
    await queue.release(relId);
    expect((await queue.getJob(relId))!.status).toBe('paused');
    expect(await queue.dequeue('worker-2')).toBeNull();
  });

  // Lifecycle ops verify ownership — a stale worker cannot ack/nack/release a
  // job a new worker now owns.
  test('lifecycle ops are scoped to the owning worker', async () => {
    const graphId = await seedGraph();
    const jobId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
    await queue.dequeue('worker-1'); // owned by worker-1

    // A different worker cannot mutate it.
    await queue.ack(jobId, 'worker-2');
    expect((await queue.getJob(jobId))!.status).toBe('active');
    await queue.nack(jobId, 'boom', 'worker-2');
    expect((await queue.getJob(jobId))!.status).toBe('active');
    await queue.release(jobId, 'worker-2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    // The legitimate owner still can.
    await queue.ack(jobId, 'worker-1');
    expect((await queue.getJob(jobId))!.status).toBe('completed');
  });

  test('reclaimExpired returns timed-out active jobs to waiting', async () => {
    const graphId = await seedGraph();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: crypto.randomUUID(),
      graph_id: graphId,
      visibility_timeout_ms: 1, // expires immediately
    });
    await queue.dequeue('worker-1');

    await new Promise(r => setTimeout(r, 10));
    const reclaimed = await queue.reclaimExpired();
    expect(reclaimed).toBe(1);
    expect((await queue.getJob(jobId))!.status).toBe('waiting');
  });

  // A worker that dies hard (SIGKILL/OOM, no ack/nack) must not loop
  // forever. Each reclaim is a failed attempt; after max_attempts the job is
  // dead-lettered instead of being reclaimed and re-dequeued endlessly.
  test('reclaimExpired dead-letters a poison-pill job after max_attempts', async () => {
    const graphId = await seedGraph();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: crypto.randomUUID(),
      graph_id: graphId,
      max_attempts: 2,
      visibility_timeout_ms: 1,
    });

    // Claim → worker dies hard → visibility expires → reclaim (attempt 1 < 2).
    await queue.dequeue('worker-1');
    await new Promise(r => setTimeout(r, 10));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('waiting');

    // Claim again → dies again → reclaim (attempt 2 >= 2 → dead_letter).
    await queue.dequeue('worker-2');
    await new Promise(r => setTimeout(r, 10));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('dead_letter');

    // The loop is broken — a dead-lettered job is never claimed again.
    expect(await queue.dequeue('worker-3')).toBeNull();
  });

  // A nacked job backs off — it is not immediately re-dequeuable, so a
  // fast-failing job doesn't burn its attempts in a tight loop.
  test('retry backoff delays re-visibility of a nacked job', async () => {
    const backoffQueue = new DrizzleWorkflowQueue({ retryBackoffMs: 10_000 });
    const graphId = await seedGraph();
    const jobId = await backoffQueue.enqueue({
      type: 'start',
      run_id: crypto.randomUUID(),
      graph_id: graphId,
      max_attempts: 3,
    });

    await backoffQueue.dequeue('worker-1'); // attempt 1
    await backoffQueue.nack(jobId, 'transient');

    // Waiting, but not yet visible → dequeue skips it.
    const job = await backoffQueue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.visible_at).not.toBeNull();
    expect(job!.visible_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await backoffQueue.dequeue('worker-2')).toBeNull();
  });

  test('heartbeat extends visibility for active jobs', async () => {
    const graphId = await seedGraph();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: crypto.randomUUID(),
      graph_id: graphId,
      visibility_timeout_ms: 60_000,
    });
    const job = await queue.dequeue('worker-1');
    const before = job!.visible_at!;

    await queue.heartbeat(jobId, 120_000);
    const db = await getDb();
    const rows = await db.select().from(workflow_jobs).where(eq(workflow_jobs.id, jobId));
    expect(rows[0].visible_at!.getTime()).toBeGreaterThan(before.getTime());
  });

  describe('run fencing', () => {
    test('stale epoch writes are rejected with StaleClaimError', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      // Worker 1's claim is reclaimed and worker 2 claims the run.
      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      expect(secondClaim!.claim_epoch).toBe(2);
      const freshOptions = createFencedRunnerOptions(secondClaim!);

      const state = createWorkflowState({
        workflow_id: graphId,
        run_id: runId,
        goal: 'fencing test',
      });

      // The new claimant writes fine; the stale claimant is rejected.
      await expect(freshOptions.persistStateFn!(state)).resolves.toBeUndefined();
      await expect(staleOptions.persistStateFn!(state)).rejects.toBeInstanceOf(StaleClaimError);

      await expect(
        freshOptions.eventLog!.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' }),
      ).resolves.toBeUndefined();
      await expect(
        staleOptions.eventLog!.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'x' }),
      ).rejects.toBeInstanceOf(StaleClaimError);
    });

    test('a stale claimant cannot compact (delete) the new claimant\'s events', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      // Worker 1 is reclaimed; worker 2 takes over and writes events.
      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      const freshOptions = createFencedRunnerOptions(secondClaim!);
      await freshOptions.eventLog!.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await freshOptions.eventLog!.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'x' });

      // The stale worker must NOT be able to delete the new claimant's events
      // (which would corrupt the new claimant's replay).
      await expect(staleOptions.eventLog!.compact(runId, 1)).rejects.toBeInstanceOf(StaleClaimError);

      // Events are intact.
      const remaining = await freshOptions.eventLog!.loadEvents(runId);
      expect(remaining.length).toBeGreaterThanOrEqual(2);
    });

    // checkpoint() was the one write path that skipped the epoch check.
    // A stale checkpoint would become the recovery anchor (loadCheckpoint reads
    // the highest sequence_id), silently resuming the new claimant from
    // rolled-back/divergent state.
    test('a stale claimant cannot write a checkpoint for the new claimant\'s run', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      const freshOptions = createFencedRunnerOptions(secondClaim!);

      const state = createWorkflowState({ workflow_id: graphId, run_id: runId, goal: 'checkpoint fencing' });

      // The new claimant checkpoints fine; the stale claimant is rejected.
      await expect(freshOptions.eventLog!.checkpoint(runId, 5, state)).resolves.toBeUndefined();
      await expect(staleOptions.eventLog!.checkpoint(runId, 9, state)).rejects.toBeInstanceOf(StaleClaimError);
    });

    test('unfenced writers are unaffected by claim epochs', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      await queue.dequeue('worker-1');

      const provider = new DrizzlePersistenceProvider();
      const state = createWorkflowState({ workflow_id: graphId, run_id: runId, goal: 'test' });
      await expect(provider.saveWorkflowSnapshot(state)).resolves.toBeUndefined();
    });
  });
});
