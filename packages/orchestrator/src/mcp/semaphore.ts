/**
 * Counting Semaphore
 *
 * Bounds the number of concurrent holders to a fixed limit. Used to cap
 * in-flight calls per MCP server so a wide fan-out (evolution / voting / map
 * candidates all hitting one server) can't overwhelm it. FIFO: waiters are
 * admitted in arrival order.
 *
 * @module mcp/semaphore
 */

/** A counting semaphore with a FIFO waiter queue. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
    this.available = limit;
  }

  /** Acquire one permit, waiting (FIFO) if none are free. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release one permit, handing it directly to the next waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Permit passes straight to the waiter; `available` stays consumed.
      next();
    } else {
      this.available = Math.min(this.limit, this.available + 1);
    }
  }

  /**
   * Run `fn` while holding a permit, releasing it even if `fn` throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
