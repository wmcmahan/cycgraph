/**
 * Run Fencing Helpers
 *
 * Wires the fencing epoch from a claimed {@link WorkflowJob} into per-job
 * fenced persistence and event-log writers for the {@link WorkflowWorker}.
 *
 * Usage:
 * ```ts
 * import { DrizzleWorkflowQueue, DrizzlePersistenceProvider, DrizzleEventLogWriter, createFencedRunnerOptions } from '@cycgraph/orchestrator-postgres';
 *
 * const worker = new WorkflowWorker({
 *   queue: new DrizzleWorkflowQueue(),
 *   persistence: new DrizzlePersistenceProvider(),
 *   eventLog: new DrizzleEventLogWriter(),
 *   // Per-job fenced writers — factory results override the worker defaults.
 *   runnerOptionsFactory: (job) => createFencedRunnerOptions(job),
 * });
 * ```
 *
 * With this wiring, a worker whose job is reclaimed (missed heartbeats
 * during a GC pause or partition) gets `StaleClaimError` on its next write
 * and aborts, instead of silently interleaving with the new claimant.
 *
 * @module @cycgraph/orchestrator-postgres/fencing
 */

import type { WorkflowJob, WorkflowState, EventLogWriter } from '@cycgraph/orchestrator';
import { DrizzlePersistenceProvider } from './drizzle-persistence.js';
import { DrizzleEventLogWriter } from './drizzle-event-log.js';

/**
 * Build per-job fenced runner options from a claimed job.
 *
 * Returns an empty object when the job carries no `claim_epoch` (queue
 * implementations without fencing) — the worker then falls back to its
 * default unfenced writers.
 *
 * The job's `tenant_id` (when present) is threaded into both writers so a
 * hosted worker — which dequeues across all tenants — stamps every
 * state/event/checkpoint row with the job's tenant and runs its writes inside
 * `withTenant` (RLS-scoped once enforced). Without this, all writes fall to the
 * seed-tenant column default via the owner connection, collapsing every
 * tenant's run history together.
 */
export function createFencedRunnerOptions(job: WorkflowJob): {
  persistStateFn?: (state: WorkflowState) => Promise<void>;
  eventLog?: EventLogWriter;
} {
  if (job.claim_epoch === undefined) return {};

  const fencing = { run_id: job.run_id, epoch: job.claim_epoch };
  const tenant = job.tenant_id ? { tenant_id: job.tenant_id } : undefined;
  const provider = new DrizzlePersistenceProvider({ fencing, tenant });
  return {
    persistStateFn: (state: WorkflowState) => provider.saveWorkflowSnapshot(state),
    eventLog: new DrizzleEventLogWriter({ fencing, tenant }),
  };
}
