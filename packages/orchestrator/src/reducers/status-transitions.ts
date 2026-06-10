/**
 * Workflow Status Transition Guard
 *
 * A single source of truth for which `WorkflowStatus` transitions are legal,
 * shared by the public `set_status` reducer and the internal lifecycle reducer.
 *
 * The invariant it enforces: **a terminal run can never return to an active
 * state.** Once a run is `completed`, `failed`, `cancelled`, or `timeout`, it
 * may not move back to `running`, `waiting`, `pending`, etc. Without this guard
 * a stray `set_status` (or a late `_init` on a recovered run) could move
 * `failed` → `running` and resurrect a dead run.
 *
 * Terminal→terminal transitions ARE allowed, because saga rollback legitimately
 * moves a `failed`/`timeout` run to `cancelled` after compensations run.
 * Transitions between non-terminal states are left permissive — the runner
 * drives those correctly, and a guard table that's too strict would reject a
 * legitimate transition. The actual bug class is terminal→active resurrection.
 *
 * @module reducers/status-transitions
 */

import type { WorkflowState } from '../types/state.js';

type WorkflowStatus = WorkflowState['status'];

/** Statuses a run can never transition out of (except to itself, idempotently). */
export const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);

/** True if `status` is a terminal (frozen) state. */
export function isTerminalStatus(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Whether a run may transition from `from` to `to`.
 *
 * - Identity transitions are always allowed (idempotent re-apply during replay).
 * - From a terminal state, only another terminal state is allowed (saga rollback
 *   moves `failed`/`timeout` → `cancelled`); returning to an active status is
 *   rejected (no resurrection).
 * - All transitions out of a non-terminal state are permitted.
 */
export function canTransitionStatus(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return isTerminalStatus(to);
  return true;
}
