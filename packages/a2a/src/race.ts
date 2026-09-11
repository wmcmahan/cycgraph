/**
 * Abort-race primitive shared by the delivery bound and the Agent Card
 * timeout.
 *
 * @module race
 */

/**
 * Settle with `promise`, or reject with `rejection()` once `signal`
 * aborts — whichever comes first. An already-aborted signal rejects
 * without subscribing.
 *
 * The awaited promise MUST be able to settle even when the underlying
 * call ignores cancellation: the loser is left to settle on its own, so
 * the point is that the CALLER observes the bound, not that the socket is
 * closed.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  rejection: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(rejection());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(rejection());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error as Error); },
    );
  });
}
