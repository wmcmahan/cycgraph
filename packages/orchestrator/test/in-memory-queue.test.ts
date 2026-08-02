import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryWorkflowQueue } from '../src/persistence/in-memory-queue';

describe('InMemoryWorkflowQueue', () => {
  let queue: InMemoryWorkflowQueue;

  const defaultInput = () => ({
    type: 'start' as const,
    run_id: crypto.randomUUID(),
    graph_id: crypto.randomUUID(),
  });

  beforeEach(() => {
    queue = new InMemoryWorkflowQueue();
  });

  it('enqueue/dequeue basic flow', async () => {
    const input = defaultInput();
    const jobId = await queue.enqueue(input);
    expect(jobId).toBeTruthy();

    const job = await queue.dequeue('worker-1');
    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.status).toBe('active');
    expect(job!.worker_id).toBe('worker-1');
    expect(job!.attempt).toBe(1);
    expect(job!.run_id).toBe(input.run_id);
  });

  it('priority ordering — lower priority dequeued first', async () => {
    const low = await queue.enqueue({ ...defaultInput(), priority: 10 });
    const high = await queue.enqueue({ ...defaultInput(), priority: 1 });

    const first = await queue.dequeue('w');
    expect(first!.id).toBe(high);

    const second = await queue.dequeue('w');
    expect(second!.id).toBe(low);
  });

  it('FIFO within same priority', async () => {
    const first = await queue.enqueue(defaultInput());
    await new Promise(r => setTimeout(r, 5));
    const second = await queue.enqueue(defaultInput());

    const job1 = await queue.dequeue('w');
    expect(job1!.id).toBe(first);

    const job2 = await queue.dequeue('w');
    expect(job2!.id).toBe(second);
  });

  it('empty queue returns null', async () => {
    const job = await queue.dequeue('w');
    expect(job).toBeNull();
  });

  it('ack transitions to completed', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');
    await queue.ack(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('completed');
    expect(job!.worker_id).toBeNull();
  });

  it('nack with retries remaining returns to waiting', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 3 });
    await queue.dequeue('w');
    await queue.nack(jobId, 'transient error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.last_error).toBe('transient error');
    expect(job!.attempt).toBe(1);
  });

  it('nack exceeds max_attempts → dead_letter', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w');
    await queue.nack(jobId, 'fatal error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('dead_letter');
    expect(job!.last_error).toBe('fatal error');
  });

  it('retry backoff delays re-visibility after nack', async () => {
    const q = new InMemoryWorkflowQueue({ retryBackoffMs: 10_000 });
    const jobId = await q.enqueue({ ...defaultInput(), max_attempts: 3 });
    await q.dequeue('w');
    await q.nack(jobId, 'transient');

    const job = await q.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.visible_at).not.toBeNull();
    expect(job!.visible_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await q.dequeue('w')).toBeNull();
  });

  it('zero backoff retries immediately (opt-out)', async () => {
    const q = new InMemoryWorkflowQueue({ retryBackoffMs: 0 });
    const jobId = await q.enqueue({ ...defaultInput(), max_attempts: 3 });
    await q.dequeue('w');
    await q.nack(jobId, 'transient');
    const next = await q.dequeue('w');
    expect(next?.id).toBe(jobId);
    expect(next?.attempt).toBe(2);
  });

  it('heartbeat extends visible_at', async () => {
    const jobId = await queue.enqueue(defaultInput());
    const job = await queue.dequeue('w');
    const originalVisibleAt = job!.visible_at!.getTime();

    await new Promise(r => setTimeout(r, 10));
    await queue.heartbeat(jobId);

    const updated = await queue.getJob(jobId);
    expect(updated!.visible_at!.getTime()).toBeGreaterThan(originalVisibleAt);
  });

  it('release transitions to paused (not re-claimable)', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');

    await queue.release(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('paused');
    expect(job!.attempt).toBe(1);
    expect(job!.worker_id).toBeNull();

    const next = await queue.dequeue('w');
    expect(next).toBeNull();
  });

  it('lifecycle ops are no-ops for a non-owning worker', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w1');
    const before = await queue.getJob(jobId);

    await queue.ack(jobId, 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.nack(jobId, 'boom', 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.release(jobId, 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.heartbeat(jobId, 999_999, 'w2');
    expect((await queue.getJob(jobId))!.visible_at?.getTime()).toBe(before!.visible_at?.getTime());

    await queue.ack(jobId, 'w1');
    expect((await queue.getJob(jobId))!.status).toBe('completed');
  });

  it('reclaimExpired returns jobs with expired visibility', async () => {
    const jobId = await queue.enqueue({
      ...defaultInput(),
      visibility_timeout_ms: 1,
    });
    await queue.dequeue('w');

    await new Promise(r => setTimeout(r, 10));

    const count = await queue.reclaimExpired();
    expect(count).toBe(1);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.worker_id).toBeNull();
  });

  it('poison-pill: reclaimExpired dead-letters a job after max_attempts', async () => {
    const jobId = await queue.enqueue({
      ...defaultInput(),
      max_attempts: 2,
      visibility_timeout_ms: 1,
    });

    await queue.dequeue('w');
    await new Promise(r => setTimeout(r, 5));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('waiting');

    await queue.dequeue('w');
    await new Promise(r => setTimeout(r, 5));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('dead_letter');

    expect(await queue.dequeue('w')).toBeNull();
  });

  it('dequeue skips active jobs', async () => {
    await queue.enqueue(defaultInput());
    await queue.dequeue('w');

    const second = await queue.dequeue('w');
    expect(second).toBeNull();
  });

  describe('unknown-job no-ops', () => {
    it('ack is a no-op for an unknown job', async () => {
      await expect(queue.ack('does-not-exist')).resolves.toBeUndefined();
    });

    it('nack is a no-op for an unknown job', async () => {
      await expect(queue.nack('does-not-exist', 'boom')).resolves.toBeUndefined();
    });

    it('heartbeat is a no-op for an unknown job', async () => {
      await expect(queue.heartbeat('does-not-exist')).resolves.toBeUndefined();
    });

    it('heartbeat is a no-op for a non-active job', async () => {
      const jobId = await queue.enqueue(defaultInput());

      await queue.heartbeat(jobId);

      expect((await queue.getJob(jobId))!.last_heartbeat_at).toBeNull();
    });

    it('release is a no-op for an unknown job', async () => {
      await expect(queue.release('does-not-exist')).resolves.toBeUndefined();
    });

    it('getJob returns null for an unknown job', async () => {
      expect(await queue.getJob('does-not-exist')).toBeNull();
    });
  });

  it('clear removes all jobs', async () => {
    const jobId = await queue.enqueue(defaultInput());

    queue.clear();

    expect(await queue.getJob(jobId)).toBeNull();
    const depth = await queue.getQueueDepth();
    expect(depth.waiting).toBe(0);
  });

  it('getQueueDepth counts by status', async () => {
    const dlId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w');
    await queue.nack(dlId, 'dead');

    await queue.enqueue(defaultInput());
    await queue.dequeue('w');

    const pausedId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');
    await queue.release(pausedId);

    await queue.enqueue(defaultInput());
    await queue.enqueue(defaultInput());

    const depth = await queue.getQueueDepth();
    expect(depth.waiting).toBe(2);
    expect(depth.active).toBe(1);
    expect(depth.paused).toBe(1);
    expect(depth.dead_letter).toBe(1);
  });
});

describe('InMemoryWorkflowQueue — fencing epochs', () => {
  it('dequeue stamps claim_epoch, bumped on every claim of the same run', async () => {
    const queue = new InMemoryWorkflowQueue({ retryBackoffMs: 0 });
    const runId = crypto.randomUUID();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: crypto.randomUUID(),
    });

    const first = await queue.dequeue('worker-1');
    expect(first?.claim_epoch).toBe(1);

    await queue.nack(jobId, 'simulated crash');
    const second = await queue.dequeue('worker-2');
    expect(second?.run_id).toBe(runId);
    expect(second?.claim_epoch).toBe(2);
  });

  it('claims of different runs have independent epochs', async () => {
    const queue = new InMemoryWorkflowQueue();
    await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: crypto.randomUUID() });
    await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: crypto.randomUUID() });

    const a = await queue.dequeue('worker-1');
    const b = await queue.dequeue('worker-1');
    expect(a?.claim_epoch).toBe(1);
    expect(b?.claim_epoch).toBe(1);
  });
});
