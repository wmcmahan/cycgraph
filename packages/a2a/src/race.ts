/**
 * Abort-race primitive shared by the delivery bound and the Agent Card
 * timeout.
 *
 * @module race
 */

/**
 * Start `start()` and settle with its promise, or reject with
 * `rejection()` once `signal` aborts — whichever comes first.
 *
 * The call is taken as a thunk rather than a promise so an
 * already-aborted signal never starts it: a call started first and
 * abandoned here would reject with an AbortError nothing is listening
 * for, and an unhandled rejection terminates the process by default.
 *
 * The awaited promise MUST be able to settle even when the underlying
 * call ignores cancellation: the loser is left to settle on its own, so
 * the point is that the CALLER observes the bound, not that the socket is
 * closed.
 */
export function raceAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  rejection: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(rejection());
  const promise = start();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(rejection());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error as Error); },
    );
  });
}
