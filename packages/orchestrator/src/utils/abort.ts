/**
 * Abort signal helpers.
 *
 * @module utils/abort
 */

/**
 * Combine multiple optional AbortSignals into one that aborts when ANY of
 * them aborts. Returns `undefined` when no signals are provided, the single
 * signal when only one is present (avoiding an unnecessary wrapper), and an
 * `AbortSignal.any([...])` otherwise.
 *
 * Used to merge a workflow-level cancellation signal with a per-task timeout
 * signal so a composite node's parallel sub-tasks actually abort the
 * underlying LLM call on timeout instead of leaving it running.
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}
