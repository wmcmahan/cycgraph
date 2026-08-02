/**
 * Unit tests for StreamChannel (runner/stream-channel.ts) — the pending-event
 * and token queues plus the single-slot notify primitive.
 */
import { describe, it, expect, vi } from 'vitest';

import { StreamChannel } from '../src/runner/stream-channel.js';
import type { StreamEvent } from '../src/runner/stream-events.js';

function tokenEvent(token: string): StreamEvent {
  return { type: 'agent:token_delta', run_id: 'r1', node_id: 'n1', token, timestamp: 0 };
}

function pendingEvent(iteration: number): StreamEvent {
  return { type: 'state:persisted', run_id: 'r1', iteration, timestamp: 0 };
}

describe('StreamChannel', () => {
  describe('pending events', () => {
    it('reports no pending events when empty', () => {
      const channel = new StreamChannel();

      expect(channel.hasPending()).toBe(false);
    });

    it('reports pending events after a push', () => {
      const channel = new StreamChannel();

      channel.pushPending(pendingEvent(1));

      expect(channel.hasPending()).toBe(true);
    });

    it('drains pending events in FIFO order and clears the queue', () => {
      const channel = new StreamChannel();
      channel.pushPending(pendingEvent(1));
      channel.pushPending(pendingEvent(2));

      const drained = [...channel.drainPending()];

      expect(drained.map((e) => (e as { iteration: number }).iteration)).toEqual([1, 2]);
      expect(channel.hasPending()).toBe(false);
    });
  });

  describe('token channel', () => {
    it('reports no tokens when empty', () => {
      const channel = new StreamChannel();

      expect(channel.hasTokens()).toBe(false);
    });

    it('flags hasTokens after a buffer push and drains FIFO', () => {
      const channel = new StreamChannel();

      channel.tokenBuffer.push(tokenEvent('a'));
      channel.tokenBuffer.push(tokenEvent('b'));

      expect(channel.hasTokens()).toBe(true);
      expect([...channel.drainTokens()].map((e) => (e as { token: string }).token)).toEqual(['a', 'b']);
      expect(channel.hasTokens()).toBe(false);
    });

    it('clears the token channel', () => {
      const channel = new StreamChannel();
      channel.tokenBuffer.push(tokenEvent('a'));

      channel.clearTokens();

      expect(channel.hasTokens()).toBe(false);
    });

    it('exposes the underlying token buffer by reference', () => {
      const channel = new StreamChannel();

      channel.tokenBuffer.push(tokenEvent('direct'));

      expect(channel.hasTokens()).toBe(true);
      expect([...channel.drainTokens()]).toHaveLength(1);
    });
  });

  describe('notify slot', () => {
    it('resolves the waiter when notify is called', async () => {
      const channel = new StreamChannel();
      const waiter = channel.waitForNotify();

      channel.notify();

      await expect(waiter).resolves.toBeUndefined();
    });

    it('resolves the waiter when the adapter path pushes a token and invokes the resolver', async () => {
      const channel = new StreamChannel();
      const waiter = channel.waitForNotify();

      channel.tokenBuffer.push(tokenEvent('a'));
      channel.currentNotify?.();

      await expect(waiter).resolves.toBeUndefined();
      expect(channel.hasTokens()).toBe(true);
    });

    it('is a no-op when nothing is waiting', () => {
      const channel = new StreamChannel();

      expect(() => channel.notify()).not.toThrow();
    });

    it('exposes the current notify resolver only while a waiter is installed', () => {
      const channel = new StreamChannel();

      expect(channel.currentNotify).toBeUndefined();

      channel.waitForNotify();
      expect(channel.currentNotify).toBeInstanceOf(Function);

      channel.notify();
      expect(channel.currentNotify).toBeUndefined();
    });

    it('overwrites a previously installed resolver (single listener)', async () => {
      const channel = new StreamChannel();
      const first = vi.fn();

      channel.waitForNotify().then(first);
      const second = channel.waitForNotify();

      channel.notify();
      await second;

      expect(first).not.toHaveBeenCalled();
    });
  });
});
