/**
 * LLM error classification.
 *
 * @module agent-executor/error-classification
 */

import { APICallError } from 'ai';

/**
 * Classify whether an LLM call error is worth retrying.
 *
 * The Vercel AI SDK surfaces provider errors as `APICallError` carrying an
 * `isRetryable` flag the provider sets per status code (429 / 5xx / 529 →
 * retryable; 400 invalid-request, context-length-exceeded, 401 / 403 / 404 →
 * not). We honor that flag, checking a wrapped `cause` too.
 *
 * Returns `undefined` for unknown errors so the retry loop keeps its default
 * (retry) — we only SHORT-CIRCUIT on a definite non-retryable signal, never
 * suppress a retry we're unsure about.
 */
export function classifyRetryable(error: unknown): boolean | undefined {
  if (APICallError.isInstance(error)) return error.isRetryable;
  const cause = (error as { cause?: unknown })?.cause;
  if (cause && APICallError.isInstance(cause)) return cause.isRetryable;
  return undefined;
}
