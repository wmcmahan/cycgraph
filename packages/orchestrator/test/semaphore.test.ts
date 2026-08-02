/**
 * Counting Semaphore — unit tests for src/mcp/semaphore.ts.
 */

import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/mcp/semaphore.js';

describe('Semaphore', () => {
  describe('constructor', () => {
    it('rejects a limit below one', () => {
      expect(() => new Semaphore(0)).toThrow(/positive integer/);
    });

    it('rejects a non-finite limit', () => {
      expect(() => new Semaphore(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
    });

    it('accepts a positive integer limit', () => {
      expect(() => new Semaphore(1)).not.toThrow();
    });
  });

  describe('run', () => {
    it('caps concurrent holders at the limit', async () => {
      const sem = new Semaphore(2);
      let inFlight = 0;
      let peak = 0;

      const task = () => sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
      });

      await Promise.all([task(), task(), task(), task(), task()]);

      expect(peak).toBe(2);
    });

    it('releases the permit even when the task throws', async () => {
      const sem = new Semaphore(1);

      await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

      const result = await sem.run(async () => 'recovered');
      expect(result).toBe('recovered');
    });
  });

  describe('acquire and release', () => {
    it('admits waiters in FIFO arrival order', async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      await sem.acquire();
      const first = sem.acquire().then(() => order.push(1));
      const second = sem.acquire().then(() => order.push(2));

      sem.release();
      await first;
      sem.release();
      await second;

      expect(order).toEqual([1, 2]);
    });

    it('does not exceed the limit when released with no waiters', () => {
      const sem = new Semaphore(2);

      sem.release();
      sem.release();
      sem.release();

      expect(() => sem.release()).not.toThrow();
    });
  });
});
