/**
 * mapWithConcurrency + Semaphore — bounded-concurrency primitives.
 */
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/utils/concurrency.js';
import { Semaphore } from '../src/mcp/semaphore.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit while still running in parallel', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });

    expect(peak).toBe(3);
  });

  it('passes the original index to the mapper', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('returns empty array for empty input', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });

  it('clamps a non-positive limit up to one', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });

    expect(peak).toBe(1);
  });
});

describe('Semaphore', () => {
  it('bounds the number of concurrent holders', async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);

    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('admits waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) => sem.run(async () => { order.push(n); }));
    await Promise.all(tasks);

    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });
});
