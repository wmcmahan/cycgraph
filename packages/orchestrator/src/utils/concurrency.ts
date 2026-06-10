/**
 * Bounded-concurrency async map.
 *
 * Runs `fn` over every item with at most `limit` invocations in flight at
 * once, preserving input order in the result array. A worker-pool design
 * (not fixed batches) so a slow item doesn't stall the whole batch — the
 * next item starts as soon as any worker frees up.
 *
 * @module utils/concurrency
 */

/**
 * Map `items` through `fn` with at most `limit` concurrent executions.
 *
 * @param items - Input values.
 * @param limit - Max in-flight invocations (clamped to ≥1).
 * @param fn - Async mapper; receives the item and its original index.
 * @returns Results in the same order as `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}
