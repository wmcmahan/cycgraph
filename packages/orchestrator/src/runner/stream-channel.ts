/**
 * Stream Channel
 *
 * Owns the two event queues the runner maintains:
 *
 *   - **pending events**: synchronous events accumulated by helper methods
 *     (budget threshold alerts, state-persisted notifications, etc.) that are
 *     drained by the main loop between yields. Strict FIFO.
 *   - **token channel**: async tokens streamed from an in-flight LLM call,
 *     interleaved with action resolution via a single-slot notify primitive.
 *
 * The channel deliberately doesn't expose its internal arrays — every queue
 * mutation goes through a named method so the relative order of pushes and
 * drains is auditable. This is the bookkeeping primitive behind the
 * runner's streaming-order invariant; touching it requires care.
 *
 * @module runner/stream-channel
 */

import type { StreamEvent } from './stream-events.js';

/**
 * Single-channel buffer for pending events + LLM tokens.
 *
 * Instance per `GraphRunner` — not safe to share across runners (the notify
 * slot is single-listener by design; concurrent waiters would race).
 */
export class StreamChannel {
  private readonly pending: StreamEvent[] = [];
  private readonly tokens: StreamEvent[] = [];
  private notifyResolver?: () => void;

  // ─── Pending events ──────────────────────────────────────────────

  /** Append an event to the pending queue. */
  pushPending(event: StreamEvent): void {
    this.pending.push(event);
  }

  /** Yield + clear every pending event in FIFO order. */
  *drainPending(): Generator<StreamEvent> {
    while (this.pending.length > 0) {
      yield this.pending.shift()!;
    }
  }

  /** True iff there are unread pending events. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  // ─── Token channel ───────────────────────────────────────────────

  /**
   * Append a token to the channel and wake any waiter on {@link waitForNotify}.
   * Used by the executor-context-builder's `onToken` / tool-call callbacks.
   */
  pushToken(event: StreamEvent): void {
    this.tokens.push(event);
    this.notify();
  }

  /** Yield + clear every queued token in FIFO order. */
  *drainTokens(): Generator<StreamEvent> {
    while (this.tokens.length > 0) {
      yield this.tokens.shift()!;
    }
  }

  /** True iff there are unread tokens. */
  hasTokens(): boolean {
    return this.tokens.length > 0;
  }

  /** Reset the token channel — called at the start of each node execution. */
  clearTokens(): void {
    this.tokens.length = 0;
  }

  /**
   * Direct access to the underlying token array. Used by the
   * executor-context-builder adapter to maintain referential equality with
   * the runner's existing closures.
   *
   * Prefer `pushToken` for normal use. The array is exposed (not cloned)
   * because the callback path needs to mutate the same buffer that
   * `drainTokens` reads — copy-on-push would break ordering.
   */
  get tokenBuffer(): StreamEvent[] {
    return this.tokens;
  }

  // ─── Notify slot ─────────────────────────────────────────────────

  /**
   * Return a promise that resolves the next time {@link notify} is called.
   * Single-listener — overwrites any previously-installed resolver. Used by
   * `executeNodeAndDrainTokens` to interleave token yields with action
   * resolution.
   */
  waitForNotify(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.notifyResolver = resolve;
    });
  }

  /**
   * Resolve the current notify-waiter, if any. No-op when nothing is waiting.
   * Called automatically by {@link pushToken} and manually from the
   * action-resolution promise so the loop wakes up even if no token arrived.
   */
  notify(): void {
    const resolver = this.notifyResolver;
    if (resolver) {
      this.notifyResolver = undefined;
      resolver();
    }
  }

  /**
   * The current notify resolver, if any. Exposed for the executor-context
   * adapter — `tokenNotify` was previously a public field on the runner.
   */
  get currentNotify(): (() => void) | undefined {
    return this.notifyResolver;
  }
}
