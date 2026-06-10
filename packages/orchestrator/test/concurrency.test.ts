/**
 * concurrency.test.ts — mapWithConcurrency + Semaphore
 */
import { describe, test, expect } from 'vitest';
import { mapWithConcurrency } from '../src/utils/concurrency.js';
import { Semaphore } from '../src/mcp/semaphore.js';

describe('mapWithConcurrency', () => {
  test('preserves input order in results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  test('passes the original index to the mapper', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  test('returns empty array for empty input', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe('Semaphore', () => {
  test('bounds the number of concurrent holders', async () => {
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

  test('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // If the permit leaked, this second run would hang forever.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  test('admits waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) => sem.run(async () => { order.push(n); }));
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  test('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });
});
