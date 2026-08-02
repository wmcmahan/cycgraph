import { describe, it, expect } from 'vitest';
import { calculateBackoff, sleep } from '../src/runner/helpers.js';

describe('Helper Utilities', () => {
  describe('calculateBackoff', () => {
    describe('linear strategy', () => {
      it('increases linearly', () => {
        expect(calculateBackoff(1, 'linear', 1000, 10000)).toBe(1000);
        expect(calculateBackoff(2, 'linear', 1000, 10000)).toBe(2000);
        expect(calculateBackoff(3, 'linear', 1000, 10000)).toBe(3000);
        expect(calculateBackoff(4, 'linear', 1000, 10000)).toBe(4000);
      });

      it('respects max backoff', () => {
        expect(calculateBackoff(20, 'linear', 1000, 10000)).toBe(10000);
      });
    });

    describe('exponential strategy', () => {
      it('increases exponentially', () => {
        expect(calculateBackoff(1, 'exponential', 1000, 60000)).toBe(1000);
        expect(calculateBackoff(2, 'exponential', 1000, 60000)).toBe(2000);
        expect(calculateBackoff(3, 'exponential', 1000, 60000)).toBe(4000);
        expect(calculateBackoff(4, 'exponential', 1000, 60000)).toBe(8000);
        expect(calculateBackoff(5, 'exponential', 1000, 60000)).toBe(16000);
      });

      it('respects max backoff', () => {
        expect(calculateBackoff(10, 'exponential', 1000, 60000)).toBe(60000);
      });

      it('handles large attempt numbers', () => {
        expect(calculateBackoff(100, 'exponential', 1000, 60000)).toBe(60000);
      });
    });

    describe('fixed strategy', () => {
      it('always returns initial backoff', () => {
        expect(calculateBackoff(1, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(2, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(10, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(100, 'fixed', 5000, 60000)).toBe(5000);
      });

      it('respects max backoff', () => {
        expect(calculateBackoff(1, 'fixed', 70000, 60000)).toBe(60000);
      });
    });

    describe('edge cases', () => {
      it('handles zero initial backoff', () => {
        expect(calculateBackoff(1, 'linear', 0, 10000)).toBe(0);
        expect(calculateBackoff(1, 'exponential', 0, 10000)).toBe(0);
        expect(calculateBackoff(1, 'fixed', 0, 10000)).toBe(0);
      });

      it('handles zero max backoff', () => {
        expect(calculateBackoff(1, 'linear', 1000, 0)).toBe(0);
        expect(calculateBackoff(1, 'exponential', 1000, 0)).toBe(0);
      });

      it('handles attempt 0', () => {
        expect(calculateBackoff(0, 'exponential', 1000, 60000)).toBe(500);
      });
    });
  });

  describe('sleep', () => {
    it('resolves after specified time', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(95);
      expect(elapsed).toBeLessThan(150);
    });

    it('handles zero delay', async () => {
      const start = Date.now();
      await sleep(0);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
    });

    it('is awaitable', async () => {
      let completed = false;

      sleep(50).then(() => {
        completed = true;
      });

      expect(completed).toBe(false);
      await sleep(60);
      expect(completed).toBe(true);
    });
  });
});
