/**
 * Persistence Errors
 *
 * Shared error types for persistence and queue adapters.
 *
 * @module persistence/errors
 */

/**
 * Thrown by fenced persistence/event-log writers when a write carries a
 * claim epoch older than the run's current epoch.
 *
 * This means another worker has claimed the run (the local claim was
 * reclaimed — e.g. after a missed heartbeat during a GC pause or network
 * partition). The local runner must abort immediately: its writes are
 * rejected, and continuing only burns tokens. The worker must NOT nack the
 * job — it no longer owns it.
 */
export class StaleClaimError extends Error {
  constructor(
    public readonly runId: string,
    public readonly staleEpoch: number,
    public readonly currentEpoch: number,
  ) {
    super(
      `Stale claim for run ${runId}: this worker holds epoch ${staleEpoch} ` +
      `but the run is now claimed at epoch ${currentEpoch}. ` +
      `Another worker owns this run — aborting local execution.`,
    );
    this.name = 'StaleClaimError';
  }
}
