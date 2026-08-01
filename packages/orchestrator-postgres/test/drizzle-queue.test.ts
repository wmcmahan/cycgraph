/**
 * Tests for `drizzle-queue.ts` — the Postgres-backed WorkflowQueue: atomic
 * claim semantics (FOR UPDATE SKIP LOCKED), visibility-timeout reclaim, the
 * ack/nack/heartbeat/release lifecycle, retry backoff, and run-fencing epochs.
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleWorkflowQueue } from '../src/drizzle-queue.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { createFencedRunnerOptions } from '../src/fencing.js';
import { graphs, workflow_jobs } from '../src/schema.js';
import { createWorkflowState, StaleClaimError } from '@cycgraph/orchestrator';

describe.skipIf(!isDatabaseAvailable())('DrizzleWorkflowQueue', () => {
  setupDatabaseTests();

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

  describe('enqueue / dequeue', () => {
    it('claims the highest-priority job first and stamps claim_epoch', async () => {
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

    it('round-trips the optional initial_state and human_response payloads', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({
        type: 'resume',
        run_id: crypto.randomUUID(),
        graph_id: graphId,
        initial_state: { seed: 'value' },
        human_response: { approved: true },
        priority: 2,
        max_attempts: 7,
        visibility_timeout_ms: 42_000,
      });

      const job = await queue.getJob(jobId);

      expect(job!.initial_state).toEqual({ seed: 'value' });
      expect(job!.human_response).toEqual({ approved: true });
      expect(job!.max_attempts).toBe(7);
      expect(job!.visibility_timeout_ms).toBe(42_000);
    });

    it('creates the run row so event appends satisfy the FK', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      await queue.dequeue('worker-1');

      const writer = new DrizzleEventLogWriter();

      await expect(
        writer.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' }),
      ).resolves.toBeUndefined();
    });

    it('bumps the fencing epoch on each re-claim of the same run', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });

      const first = await queue.dequeue('worker-1');
      expect(first!.claim_epoch).toBe(1);

      await queue.nack(first!.id, 'simulated crash');
      const second = await queue.dequeue('worker-2');

      expect(second!.run_id).toBe(runId);
      expect(second!.claim_epoch).toBe(2);
    });
  });

  describe('claim exclusivity', () => {
    it('does not let a second worker claim an already-claimed job', async () => {
      const graphId = await seedGraph();
      await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });

      const job1 = await queue.dequeue('worker-1');
      const job2 = await queue.dequeue('worker-2');

      expect(job1).not.toBeNull();
      expect(job2).toBeNull();
    });

    it('never lets concurrent dequeues claim the same job (SKIP LOCKED)', async () => {
      const graphId = await seedGraph();
      for (let i = 0; i < 5; i++) {
        await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
      }

      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, i) => queue.dequeue(`worker-${i}`)),
      );

      const claimed = claims.filter((j): j is NonNullable<typeof j> => j !== null);
      expect(claimed).toHaveLength(5);
      expect(new Set(claimed.map(j => j.id)).size).toBe(5);
    });
  });

  describe('nack', () => {
    it('returns a job to waiting before max_attempts and dead-letters at max_attempts', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      const jobId = await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId, max_attempts: 2 });

      await queue.dequeue('worker-1');
      await queue.nack(jobId, 'boom 1');
      expect((await queue.getJob(jobId))!.status).toBe('waiting');

      await queue.dequeue('worker-1');
      await queue.nack(jobId, 'boom 2');
      const dead = await queue.getJob(jobId);

      expect(dead!.status).toBe('dead_letter');
      expect(dead!.last_error).toBe('boom 2');
      expect((await queue.getQueueDepth()).dead_letter).toBe(1);
    });
  });

  describe('ack / release', () => {
    it('ack completes the job', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
      await queue.dequeue('worker-1');

      await queue.ack(jobId);

      expect((await queue.getJob(jobId))!.status).toBe('completed');
    });

    it('release pauses the job so it is not re-claimable', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
      await queue.dequeue('worker-1');

      await queue.release(jobId);

      expect((await queue.getJob(jobId))!.status).toBe('paused');
      expect(await queue.dequeue('worker-2')).toBeNull();
    });

    it('scopes lifecycle ops to the owning worker', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: graphId });
      await queue.dequeue('worker-1');

      await queue.ack(jobId, 'worker-2');
      expect((await queue.getJob(jobId))!.status).toBe('active');
      await queue.nack(jobId, 'boom', 'worker-2');
      expect((await queue.getJob(jobId))!.status).toBe('active');
      await queue.release(jobId, 'worker-2');
      expect((await queue.getJob(jobId))!.status).toBe('active');

      await queue.ack(jobId, 'worker-1');
      expect((await queue.getJob(jobId))!.status).toBe('completed');
    });
  });

  describe('reclaimExpired', () => {
    it('returns timed-out active jobs to waiting', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({
        type: 'start',
        run_id: crypto.randomUUID(),
        graph_id: graphId,
        visibility_timeout_ms: 1,
      });
      await queue.dequeue('worker-1');

      await new Promise(r => setTimeout(r, 10));
      const reclaimed = await queue.reclaimExpired();

      expect(reclaimed).toBe(1);
      expect((await queue.getJob(jobId))!.status).toBe('waiting');
    });

    it('dead-letters a poison-pill job after max_attempts of reclaims', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({
        type: 'start',
        run_id: crypto.randomUUID(),
        graph_id: graphId,
        max_attempts: 2,
        visibility_timeout_ms: 1,
      });

      await queue.dequeue('worker-1');
      await new Promise(r => setTimeout(r, 10));
      await queue.reclaimExpired();
      expect((await queue.getJob(jobId))!.status).toBe('waiting');

      await queue.dequeue('worker-2');
      await new Promise(r => setTimeout(r, 10));
      await queue.reclaimExpired();
      expect((await queue.getJob(jobId))!.status).toBe('dead_letter');

      expect(await queue.dequeue('worker-3')).toBeNull();
    });
  });

  describe('retry backoff', () => {
    it('delays re-visibility of a nacked job', async () => {
      const backoffQueue = new DrizzleWorkflowQueue({ retryBackoffMs: 10_000 });
      const graphId = await seedGraph();
      const jobId = await backoffQueue.enqueue({
        type: 'start',
        run_id: crypto.randomUUID(),
        graph_id: graphId,
        max_attempts: 3,
      });

      await backoffQueue.dequeue('worker-1');
      await backoffQueue.nack(jobId, 'transient');

      const job = await backoffQueue.getJob(jobId);
      expect(job!.status).toBe('waiting');
      expect(job!.visible_at).not.toBeNull();
      expect(job!.visible_at!.getTime()).toBeGreaterThan(Date.now());
      expect(await backoffQueue.dequeue('worker-2')).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('extends visibility by an explicit extendMs', async () => {
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

    it('falls back to the job\'s visibility timeout when extendMs is omitted', async () => {
      const graphId = await seedGraph();
      const jobId = await queue.enqueue({
        type: 'start',
        run_id: crypto.randomUUID(),
        graph_id: graphId,
        visibility_timeout_ms: 60_000,
      });
      const job = await queue.dequeue('worker-1');
      const before = job!.visible_at!;

      await queue.heartbeat(jobId);

      const db = await getDb();
      const rows = await db.select().from(workflow_jobs).where(eq(workflow_jobs.id, jobId));
      expect(rows[0].visible_at!.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe('getJob', () => {
    it('returns null for an unknown job id', async () => {
      const job = await queue.getJob(crypto.randomUUID());

      expect(job).toBeNull();
    });
  });

  describe('run fencing', () => {
    it('rejects stale-epoch state and event writes with StaleClaimError', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      expect(secondClaim!.claim_epoch).toBe(2);
      const freshOptions = createFencedRunnerOptions(secondClaim!);

      const state = createWorkflowState({ workflow_id: graphId, run_id: runId, goal: 'fencing test' });

      await expect(freshOptions.persistStateFn!(state)).resolves.toBeUndefined();
      await expect(staleOptions.persistStateFn!(state)).rejects.toBeInstanceOf(StaleClaimError);

      await expect(
        freshOptions.eventLog!.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' }),
      ).resolves.toBeUndefined();
      await expect(
        staleOptions.eventLog!.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'x' }),
      ).rejects.toBeInstanceOf(StaleClaimError);
    });

    it('prevents a stale claimant from compacting the new claimant\'s events', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      const freshOptions = createFencedRunnerOptions(secondClaim!);
      await freshOptions.eventLog!.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await freshOptions.eventLog!.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'x' });

      await expect(staleOptions.eventLog!.compact(runId, 1)).rejects.toBeInstanceOf(StaleClaimError);

      const remaining = await freshOptions.eventLog!.loadEvents(runId);
      expect(remaining.length).toBeGreaterThanOrEqual(2);
    });

    it('prevents a stale claimant from writing a checkpoint for the new claimant\'s run', async () => {
      const graphId = await seedGraph();
      const runId = crypto.randomUUID();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graphId });
      const firstClaim = await queue.dequeue('worker-1');
      const staleOptions = createFencedRunnerOptions(firstClaim!);

      await queue.nack(firstClaim!.id, 'simulated partition');
      const secondClaim = await queue.dequeue('worker-2');
      const freshOptions = createFencedRunnerOptions(secondClaim!);

      const state = createWorkflowState({ workflow_id: graphId, run_id: runId, goal: 'checkpoint fencing' });

      await expect(freshOptions.eventLog!.checkpoint(runId, 5, state)).resolves.toBeUndefined();
      await expect(staleOptions.eventLog!.checkpoint(runId, 9, state)).rejects.toBeInstanceOf(StaleClaimError);
    });

    it('leaves unfenced writers unaffected by claim epochs', async () => {
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
