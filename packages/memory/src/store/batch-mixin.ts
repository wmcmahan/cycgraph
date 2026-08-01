/**
 * Batch Get Mixin
 *
 * Provides a fallback implementation for batch get operations by
 * issuing parallel single-get calls. Use this when a store backend
 * does not support native batch retrieval (e.g., a simple key-value store).
 *
 * Production backends (Postgres) should implement batch methods natively
 * using `WHERE id = ANY($1)` for a single round-trip.
 *
 * @module store/batch-mixin
 */

/**
 * Generic batch-get fallback: resolves N single-get calls in parallel,
 * returning a Map of found records.
 *
 * @param getSingle - The single-get function (e.g., `store.getEntity`).
 * @returns Map from ID to record (missing IDs are absent).
 */
export async function batchGetFallback<T>(
  ids: string[],
  getSingle: (id: string) => Promise<T | null>,
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (ids.length === 0) return result;

  const entries = await Promise.all(
    ids.map(async (id) => {
      const item = await getSingle(id);
      return [id, item] as const;
    }),
  );

  for (const [id, item] of entries) {
    if (item !== null) {
      result.set(id, item);
    }
  }

  return result;
}
