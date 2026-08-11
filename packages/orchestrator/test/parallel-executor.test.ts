/**
 * executeParallel — worker-pool fan-out with concurrency + timeout control.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { executeParallel, type ParallelTask } from '../src/execution/engine/parallel-executor.js';
import type { Action } from '../src/state/state.js';

const makeTask = (nodeId: string): ParallelTask => ({
  node: {
    id: nodeId,
    type: 'agent',
    agent_id: `agent-${nodeId}`,
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
  },
  stateView: {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    goal: 'test',
    constraints: [],
    memory: {},
  },
});

const makeAction = (nodeId: string): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type: 'update_memory',
  payload: { updates: { [`${nodeId}_result`]: 'done' } },
  metadata: {
    node_id: nodeId,
    timestamp: new Date(),
    attempt: 1,
    token_usage: { totalTokens: 100 },
  } as any,
});

describe('executeParallel', () => {
  it('executes all tasks and collects results', async () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const executeFn = vi.fn(async (task: ParallelTask) => makeAction(task.node.id));

    const results = await executeParallel(tasks, executeFn, {
      maxConcurrency: 10,
      errorStrategy: 'best_effort',
    });

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(3);
  });

  it('never exceeds maxConcurrency in flight', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(`t${i}`));
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const executeFn = vi.fn(async (task: ParallelTask) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 10));
      currentConcurrent--;
      return makeAction(task.node.id);
    });

    await executeParallel(tasks, executeFn, {
      maxConcurrency: 2,
      errorStrategy: 'best_effort',
    });

    expect(maxConcurrent).toBe(2);
  });

  it('assigns the correct taskIndex and nodeId to each result', async () => {
    const tasks = [makeTask('x'), makeTask('y'), makeTask('z')];
    const executeFn = vi.fn(async (task: ParallelTask) => makeAction(task.node.id));

    const results = await executeParallel(tasks, executeFn, {
      maxConcurrency: 10,
      errorStrategy: 'best_effort',
    });

    expect(results.map(r => r.taskIndex).sort()).toEqual([0, 1, 2]);
    expect(results.map(r => r.nodeId).sort()).toEqual(['x', 'y', 'z']);
  });

  it('tracks token usage per result', async () => {
    const tasks = [makeTask('a')];
    const executeFn = vi.fn(async () => makeAction('a'));

    const results = await executeParallel(tasks, executeFn, {
      maxConcurrency: 1,
      errorStrategy: 'best_effort',
    });

    expect(results[0].tokensUsed).toBe(100);
  });

  it('carries per-item stateView and item metadata to the executor', async () => {
    const task: ParallelTask = {
      ...makeTask('worker'),
      inputItem: { text: 'hello' },
      itemIndex: 0,
    };
    const executeFn = vi.fn(async (t: ParallelTask) => {
      expect(t.inputItem).toEqual({ text: 'hello' });
      expect(t.itemIndex).toBe(0);
      return makeAction(t.node.id);
    });

    await executeParallel([task], executeFn, {
      maxConcurrency: 1,
      errorStrategy: 'best_effort',
    });

    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('returns no results for an empty task list', async () => {
    const executeFn = vi.fn();

    const results = await executeParallel([], executeFn, {
      maxConcurrency: 5,
      errorStrategy: 'best_effort',
    });

    expect(results).toHaveLength(0);
    expect(executeFn).not.toHaveBeenCalled();
  });

  describe('error handling', () => {
    it('collects failures as unsuccessful results in best_effort mode', async () => {
      const tasks = [makeTask('good'), makeTask('bad'), makeTask('good2')];
      const executeFn = vi.fn(async (task: ParallelTask) => {
        if (task.node.id === 'bad') throw new Error('Task failed');
        return makeAction(task.node.id);
      });

      const results = await executeParallel(tasks, executeFn, {
        maxConcurrency: 10,
        errorStrategy: 'best_effort',
      });

      expect(results.filter(r => r.success)).toHaveLength(2);
      const failures = results.filter(r => !r.success);
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toBe('Task failed');
    });

    it('throws on the first failure in fail_fast mode', async () => {
      const tasks = [makeTask('a'), makeTask('fail'), makeTask('c')];
      const executeFn = vi.fn(async (task: ParallelTask) => {
        if (task.node.id === 'fail') throw new Error('Fast fail');
        return makeAction(task.node.id);
      });

      await expect(
        executeParallel(tasks, executeFn, {
          maxConcurrency: 10,
          errorStrategy: 'fail_fast',
        }),
      ).rejects.toThrow('Fast fail');
    });

    it('stringifies a non-Error thrown value into the result error', async () => {
      const tasks = [makeTask('a')];
      const executeFn = vi.fn(async () => { throw 'plain string failure'; });

      const results = await executeParallel(tasks, executeFn, {
        maxConcurrency: 1,
        errorStrategy: 'best_effort',
      });

      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('plain string failure');
    });
  });

  describe('task timeout', () => {
    it('passes a per-task abort signal that fires on timeout', async () => {
      let observedSignal: AbortSignal | undefined;
      let abortedDuringRun = false;
      const tasks = [makeTask('slow')];
      const executeFn = vi.fn(async (task: ParallelTask, signal?: AbortSignal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => { abortedDuringRun = true; resolve(); }, { once: true });
        });
        return makeAction(task.node.id);
      });

      await executeParallel(tasks, executeFn, {
        maxConcurrency: 1,
        errorStrategy: 'best_effort',
        taskTimeoutMs: 20,
      });

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(abortedDuringRun).toBe(true);
    });

    it('marks a task that exceeds taskTimeoutMs as a timed-out failure', async () => {
      const tasks = [makeTask('fast'), makeTask('slow')];
      const executeFn = vi.fn(async (task: ParallelTask) => {
        if (task.node.id === 'slow') {
          await new Promise(r => setTimeout(r, 5000));
        }
        return makeAction(task.node.id);
      });

      const results = await executeParallel(tasks, executeFn, {
        maxConcurrency: 10,
        errorStrategy: 'best_effort',
        taskTimeoutMs: 50,
      });

      expect(results.find(r => r.nodeId === 'fast')?.success).toBe(true);
      const slow = results.find(r => r.nodeId === 'slow');
      expect(slow?.success).toBe(false);
      expect(slow?.error).toMatch(/timed out/);
    });

    it('keeps a task that resolves as the abort fires (aborted signal, no double-abort)', async () => {
      const tasks = [makeTask('racer')];
      const executeFn = vi.fn((task: ParallelTask, signal?: AbortSignal) =>
        new Promise<Action>((resolve) => {
          signal?.addEventListener('abort', () => resolve(makeAction(task.node.id)), { once: true });
        }));

      const results = await executeParallel(tasks, executeFn, {
        maxConcurrency: 1,
        errorStrategy: 'best_effort',
        taskTimeoutMs: 20,
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].nodeId).toBe('racer');
    });

    it('does not time out tasks when taskTimeoutMs is unset', async () => {
      const tasks = [makeTask('a')];
      const executeFn = vi.fn(async (task: ParallelTask) => {
        await new Promise(r => setTimeout(r, 10));
        return makeAction(task.node.id);
      });

      const results = await executeParallel(tasks, executeFn, {
        maxConcurrency: 10,
        errorStrategy: 'best_effort',
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });
});
