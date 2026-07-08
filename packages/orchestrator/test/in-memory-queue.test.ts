import { describe, test, expect, beforeEach } from 'vitest';
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

  test('enqueue/dequeue basic flow', async () => {
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

  test('priority ordering — lower priority dequeued first', async () => {
    const low = await queue.enqueue({ ...defaultInput(), priority: 10 });
    const high = await queue.enqueue({ ...defaultInput(), priority: 1 });

    const first = await queue.dequeue('w');
    expect(first!.id).toBe(high);

    const second = await queue.dequeue('w');
    expect(second!.id).toBe(low);
  });

  test('FIFO within same priority', async () => {
    const first = await queue.enqueue(defaultInput());
    // Tiny delay to ensure different created_at
    await new Promise(r => setTimeout(r, 5));
    const second = await queue.enqueue(defaultInput());

    const job1 = await queue.dequeue('w');
    expect(job1!.id).toBe(first);

    const job2 = await queue.dequeue('w');
    expect(job2!.id).toBe(second);
  });

  test('empty queue returns null', async () => {
    const job = await queue.dequeue('w');
    expect(job).toBeNull();
  });

  test('ack transitions to completed', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');
    await queue.ack(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('completed');
    expect(job!.worker_id).toBeNull();
  });

  test('nack with retries remaining returns to waiting', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 3 });
    await queue.dequeue('w'); // attempt = 1
    await queue.nack(jobId, 'transient error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.last_error).toBe('transient error');
    expect(job!.attempt).toBe(1); // nack doesn't increment — dequeue does
  });

  test('nack exceeds max_attempts → dead_letter', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w'); // attempt = 1 (now equals max_attempts)
    await queue.nack(jobId, 'fatal error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('dead_letter');
    expect(job!.last_error).toBe('fatal error');
  });

  // A nacked job backs off — it's not immediately re-dequeuable, so a
  // fast-failing job doesn't burn its attempts in a tight loop.
  test('retry backoff delays re-visibility after nack', async () => {
    const q = new InMemoryWorkflowQueue({ retryBackoffMs: 10_000 });
    const jobId = await q.enqueue({ ...defaultInput(), max_attempts: 3 });
    await q.dequeue('w'); // attempt = 1
    await q.nack(jobId, 'transient');

    const job = await q.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.visible_at).not.toBeNull();
    expect(job!.visible_at!.getTime()).toBeGreaterThan(Date.now());
    // Not yet visible → dequeue skips it.
    expect(await q.dequeue('w')).toBeNull();
  });

  test('zero backoff retries immediately (opt-out)', async () => {
    const q = new InMemoryWorkflowQueue({ retryBackoffMs: 0 });
    const jobId = await q.enqueue({ ...defaultInput(), max_attempts: 3 });
    await q.dequeue('w');
    await q.nack(jobId, 'transient');
    const next = await q.dequeue('w');
    expect(next?.id).toBe(jobId);
    expect(next?.attempt).toBe(2);
  });

  test('heartbeat extends visible_at', async () => {
    const jobId = await queue.enqueue(defaultInput());
    const job = await queue.dequeue('w');
    const originalVisibleAt = job!.visible_at!.getTime();

    // Small delay to get a different timestamp
    await new Promise(r => setTimeout(r, 10));
    await queue.heartbeat(jobId);

    const updated = await queue.getJob(jobId);
    expect(updated!.visible_at!.getTime()).toBeGreaterThan(originalVisibleAt);
  });

  test('release transitions to paused (not re-claimable)', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w'); // attempt = 1

    await queue.release(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('paused');
    expect(job!.attempt).toBe(1); // preserved, not incremented
    expect(job!.worker_id).toBeNull();

    // Paused jobs must not be returned by dequeue
    const next = await queue.dequeue('w');
    expect(next).toBeNull();
  });

  // Lifecycle ops must verify ownership. A stale worker whose job was
  // reclaimed cannot ack/nack/release/heartbeat the job a new worker now owns.
  test('lifecycle ops are no-ops for a non-owning worker', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w1'); // owned by w1
    const before = await queue.getJob(jobId);

    // A different worker cannot mutate it.
    await queue.ack(jobId, 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.nack(jobId, 'boom', 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.release(jobId, 'w2');
    expect((await queue.getJob(jobId))!.status).toBe('active');

    await queue.heartbeat(jobId, 999_999, 'w2');
    expect((await queue.getJob(jobId))!.visible_at?.getTime()).toBe(before!.visible_at?.getTime());

    // The legitimate owner still can.
    await queue.ack(jobId, 'w1');
    expect((await queue.getJob(jobId))!.status).toBe('completed');
  });

  test('reclaimExpired returns jobs with expired visibility', async () => {
    const jobId = await queue.enqueue({
      ...defaultInput(),
      visibility_timeout_ms: 1, // 1ms — will expire immediately
    });
    await queue.dequeue('w');

    // Wait for visibility to expire
    await new Promise(r => setTimeout(r, 10));

    const count = await queue.reclaimExpired();
    expect(count).toBe(1);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.worker_id).toBeNull();
  });

  // A worker that dies hard (no ack/nack) must not loop forever. Each
  // reclaim counts as a failed attempt; after max_attempts the job is
  // dead-lettered instead of being handed out again.
  test('poison-pill: reclaimExpired dead-letters a job after max_attempts', async () => {
    const jobId = await queue.enqueue({
      ...defaultInput(),
      max_attempts: 2,
      visibility_timeout_ms: 1,
    });

    // Claim → worker dies hard → visibility expires → reclaim (attempt 1 < 2).
    await queue.dequeue('w'); // attempt = 1
    await new Promise(r => setTimeout(r, 5));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('waiting');

    // Claim again → dies again → reclaim (attempt 2 >= 2 → dead_letter).
    await queue.dequeue('w'); // attempt = 2
    await new Promise(r => setTimeout(r, 5));
    await queue.reclaimExpired();
    expect((await queue.getJob(jobId))!.status).toBe('dead_letter');

    // The loop is broken: a dead-lettered job is never handed out again.
    expect(await queue.dequeue('w')).toBeNull();
  });

  test('dequeue skips active jobs', async () => {
    const id1 = await queue.enqueue(defaultInput());
    await queue.dequeue('w'); // id1 is now active

    const second = await queue.dequeue('w');
    expect(second).toBeNull(); // no more waiting jobs
  });

  test('getQueueDepth counts by status', async () => {
    // 1 dead_letter — enqueue and exhaust first so dequeue doesn't pick others
    const dlId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w');
    await queue.nack(dlId, 'dead');

    // 1 active
    await queue.enqueue(defaultInput());
    await queue.dequeue('w');

    // 1 paused
    const pausedId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');
    await queue.release(pausedId);

    // 2 waiting
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
  test('dequeue stamps claim_epoch, bumped on every claim of the same run', async () => {
    // Zero backoff so the nack→re-dequeue is immediate (this tests epoch
    // mechanics, not retry backoff).
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

  test('claims of different runs have independent epochs', async () => {
    const queue = new InMemoryWorkflowQueue();
    await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: crypto.randomUUID() });
    await queue.enqueue({ type: 'start', run_id: crypto.randomUUID(), graph_id: crypto.randomUUID() });

    const a = await queue.dequeue('worker-1');
    const b = await queue.dequeue('worker-1');
    expect(a?.claim_epoch).toBe(1);
    expect(b?.claim_epoch).toBe(1);
  });
});
