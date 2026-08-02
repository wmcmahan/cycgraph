/**
 * Per-Tool Circuit Breaker — Unit Tests
 *
 * Covers state-machine transitions, threshold semantics, cooldown timing, and
 * the metrics surface.
 */

import { describe, it, expect } from 'vitest';
import {
  ToolCircuitBreakerManager,
  ToolCircuitBreakerOpenError,
} from '../src/index.js';

describe('ToolCircuitBreakerManager', () => {
  describe('state transitions', () => {
    it('is closed when a tool has never failed', () => {
      const mgr = new ToolCircuitBreakerManager();
      expect(() => mgr.check('s1', 't1')).not.toThrow();
      expect(mgr.getMetrics()).toHaveLength(0);
    });

    it('records success and failure counts without opening below threshold', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 5 });
      mgr.recordFailure('s1', 't1');
      mgr.recordFailure('s1', 't1');
      mgr.recordSuccess('s1', 't1');

      expect(() => mgr.check('s1', 't1')).not.toThrow();
      const metrics = mgr.getMetrics().find(m => m.tool_name === 't1');
      expect(metrics?.status).toBe('closed');
      expect(metrics?.total_failures).toBe(2);
      expect(metrics?.total_successes).toBe(1);
      expect(metrics?.consecutive_failures).toBe(0);
    });

    it('opens after failure_threshold consecutive failures', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 3 });
      for (let i = 0; i < 3; i++) mgr.recordFailure('s1', 't1');

      expect(() => mgr.check('s1', 't1')).toThrow(ToolCircuitBreakerOpenError);
      const metrics = mgr.getMetrics()[0];
      expect(metrics.status).toBe('open');
      expect(metrics.opened_at).toBeGreaterThan(0);
    });

    it('throws ToolCircuitBreakerOpenError with the expected fields when open', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 2, cooldown_ms: 30_000 });
      mgr.recordFailure('server-x', 'tool-y');
      mgr.recordFailure('server-x', 'tool-y');

      try {
        mgr.check('server-x', 'tool-y');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolCircuitBreakerOpenError);
        const e = err as ToolCircuitBreakerOpenError;
        expect(e.serverId).toBe('server-x');
        expect(e.toolName).toBe('tool-y');
        expect(e.retryAfterMs).toBeGreaterThan(0);
        expect(e.retryAfterMs).toBeLessThanOrEqual(30_000);
      }
    });

    it('transitions open → half_open after cooldown elapses', async () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 1, cooldown_ms: 20 });
      mgr.recordFailure('s1', 't1');

      expect(() => mgr.check('s1', 't1')).toThrow(ToolCircuitBreakerOpenError);

      await new Promise(resolve => setTimeout(resolve, 30));

      expect(() => mgr.check('s1', 't1')).not.toThrow();
      expect(mgr.getMetrics()[0].status).toBe('half_open');
    });

    it('closes from half_open after success_threshold consecutive successes', async () => {
      const mgr = new ToolCircuitBreakerManager({
        failure_threshold: 1,
        success_threshold: 2,
        cooldown_ms: 10,
      });
      mgr.recordFailure('s1', 't1');
      await new Promise(resolve => setTimeout(resolve, 20));
      mgr.check('s1', 't1'); // transitions to half_open

      mgr.recordSuccess('s1', 't1');
      expect(mgr.getMetrics()[0].status).toBe('half_open');

      mgr.recordSuccess('s1', 't1');
      expect(mgr.getMetrics()[0].status).toBe('closed');
    });

    it('re-opens immediately on any failure while in half_open', async () => {
      const mgr = new ToolCircuitBreakerManager({
        failure_threshold: 1,
        success_threshold: 5,
        cooldown_ms: 10,
      });
      mgr.recordFailure('s1', 't1');
      await new Promise(resolve => setTimeout(resolve, 20));
      mgr.check('s1', 't1');

      mgr.recordFailure('s1', 't1');
      expect(mgr.getMetrics()[0].status).toBe('open');
    });

    it('allows repeated probes without throwing while in half_open', async () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 1, success_threshold: 5, cooldown_ms: 10 });
      mgr.recordFailure('s1', 't1');
      await new Promise(resolve => setTimeout(resolve, 20));
      mgr.check('s1', 't1');

      expect(() => mgr.check('s1', 't1')).not.toThrow();
      expect(mgr.getMetrics()[0].status).toBe('half_open');
    });

    it('keeps counting lifetime failures when recordFailure is called while open', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 2, cooldown_ms: 60_000 });
      mgr.recordFailure('s1', 't1');
      mgr.recordFailure('s1', 't1');
      expect(mgr.getMetrics()[0].status).toBe('open');

      mgr.recordFailure('s1', 't1');

      const m = mgr.getMetrics()[0];
      expect(m.status).toBe('open');
      expect(m.total_failures).toBe(3);
      expect(m.consecutive_failures).toBe(2);
    });
  });

  describe('isolation between tools', () => {
    it('tracks separate breakers per (server, tool) pair', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 2 });
      mgr.recordFailure('s1', 't1');
      mgr.recordFailure('s1', 't1');

      expect(() => mgr.check('s1', 't1')).toThrow(ToolCircuitBreakerOpenError);
      expect(() => mgr.check('s1', 't2')).not.toThrow();
      expect(() => mgr.check('s2', 't1')).not.toThrow();
    });
  });

  describe('reset', () => {
    it('clears the breaker state for a single tool', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 1 });
      mgr.recordFailure('s1', 't1');
      expect(() => mgr.check('s1', 't1')).toThrow();

      mgr.reset('s1', 't1');
      expect(() => mgr.check('s1', 't1')).not.toThrow();
      expect(mgr.getMetrics()).toHaveLength(0);
    });
  });

  describe('metrics', () => {
    it('exposes lifetime totals that never reset', () => {
      const mgr = new ToolCircuitBreakerManager({ failure_threshold: 100 });
      for (let i = 0; i < 7; i++) mgr.recordSuccess('s1', 't1');
      for (let i = 0; i < 3; i++) mgr.recordFailure('s1', 't1');
      for (let i = 0; i < 4; i++) mgr.recordSuccess('s1', 't1');

      const m = mgr.getMetrics()[0];
      expect(m.total_calls).toBe(14);
      expect(m.total_successes).toBe(11);
      expect(m.total_failures).toBe(3);
      expect(m.consecutive_failures).toBe(0);
    });
  });
});
