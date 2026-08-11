/**
 * Runner Helpers
 *
 * Utility functions used by the graph runner and retry logic.
 *
 * @module execution/engine/helpers
 */

/**
 * Calculate backoff delay for retry attempts.
 *
 * @param attempt - Current attempt number (1-indexed).
 * @param strategy - Backoff strategy to use.
 * @param initial_ms - Initial backoff in milliseconds.
 * @param max_ms - Maximum backoff in milliseconds.
 * @returns Backoff delay in milliseconds, clamped to `max_ms`.
 */
export function calculateBackoff(
  attempt: number,
  strategy: 'linear' | 'exponential' | 'fixed',
  initial_ms: number,
  max_ms: number,
): number {
  let backoff: number;

  switch (strategy) {
    case 'linear':
      backoff = initial_ms * attempt;
      break;
    case 'exponential':
      backoff = initial_ms * Math.pow(2, attempt - 1);
      break;
    case 'fixed':
      backoff = initial_ms;
      break;
  }

  return Math.min(backoff, max_ms);
}

/**
 * Sleep for the specified duration.
 *
 * @param ms - Milliseconds to sleep.
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
