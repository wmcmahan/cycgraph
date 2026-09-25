/**
 * Adapter errors.
 *
 * @module errors
 */

/**
 * Thrown when a delivery's bound — the `timeoutMs` budget or the caller's
 * abort — fires while the remote task it started is still `submitted` or
 * `working`.
 *
 * The task has not ended, so it is not reported as a task state: the
 * remote may still finish it, and `taskId` names it for anyone who wants
 * to follow up. `retryable` is `false` because a retry re-issues the work
 * as a NEW remote task while this one keeps running, duplicating remote
 * spend and side effects.
 */
export class A2ATaskPendingError extends Error {
  /** Stops the runner's failure policy from re-issuing the task. */
  readonly retryable = false;

  constructor(
    /** Server-generated id of the task still running on the remote. */
    public readonly taskId: string,
    /** Which bound ended the wait. */
    public readonly reason: 'timeout' | 'aborted',
    /** The delivery budget that applied, in milliseconds. */
    public readonly timeoutMs: number,
  ) {
    super(
      reason === 'aborted'
        ? `A2A delivery aborted by the caller while task ${taskId} was still running on the remote`
        : `A2A task ${taskId} was still running on the remote when the ${timeoutMs}ms budget ran out`,
    );
    this.name = 'A2ATaskPendingError';
  }
}
