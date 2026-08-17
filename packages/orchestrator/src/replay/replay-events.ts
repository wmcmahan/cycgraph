/**
 * Event Replay
 *
 * Reconstructs workflow state by folding a run's events through the same
 * reducers the live run used. No LLM calls and no I/O: the stored `Action`
 * objects already carry the agent outputs, so a replay is pure computation
 * over the log.
 *
 * Two callers, one loop. Recovery replays a whole log to resume a crashed
 * run. Forking replays a prefix and stops, then diverges. The difference is
 * expressed entirely by {@link ReplayOptions.stopBefore}, so both paths
 * reconstruct state identically and a fork's prefix is bit-for-bit the state
 * the original run held.
 *
 * @module replay/replay-events
 */

import { v4 as uuidv4 } from 'uuid';
import type { WorkflowState, Action } from '../state/state.js';
import { rootReducer, internalReducer, REPLAY_VERSION } from '../state/reducers.js';
import type { WorkflowEvent } from '../persistence/event.js';

/** The `(node, iteration)` pair of an action applied during replay. */
export interface ReplayedAction {
  nodeId: string;
  iterationCount: number;
}

/** What {@link ReplayOptions.stopBefore} is asked about. */
export interface ReplayStopContext {
  /** The event that is about to be applied. */
  event: WorkflowEvent;
  /** State as of every prior event — this one has NOT been applied yet. */
  state: WorkflowState;
  /** Position of `event` within the replayed array. */
  index: number;
}

/** Options for {@link replayEvents}. */
export interface ReplayOptions {
  /**
   * Halt before applying the first event this returns `true` for.
   *
   * The returned state excludes that event, which is what makes a fork
   * addressed "before node X" reconstruct the state X was about to read.
   */
  stopBefore?: (ctx: ReplayStopContext) => boolean;
  /**
   * Called when a `workflow_started` event carries a different
   * `replay_version` than the reducers currently implement. The log was
   * written under different semantics, so the reconstructed state may be one
   * the original run never held. Recovery warns; forking refuses.
   */
  onVersionMismatch?: (loggedVersion: unknown, currentVersion: number) => void;
}

/** Outcome of a replay. */
export interface ReplayResult {
  /** Reconstructed state. */
  state: WorkflowState;
  /** Every `(node, iteration)` pair applied, for idempotency rehydration. */
  executedActionIds: ReplayedAction[];
  /** Count of `action_dispatched` events applied. */
  replayedActions: number;
  /** Count of `internal_dispatched` events applied. */
  replayedInternals: number;
  /** `sequence_id` of the last event applied, or `null` if none were. */
  lastAppliedSequenceId: number | null;
  /** The event `stopBefore` halted on, if it fired. */
  stoppedAt?: WorkflowEvent;
}

/**
 * Fold events into state through the runtime reducers.
 *
 * Pure: no I/O, no clock reads. Timestamps come from the events themselves,
 * which is what keeps replay byte-identical to the original run.
 *
 * @param events     Events in `sequence_id` order, contiguity already checked.
 * @param startState State to fold onto — a checkpoint, or a minimal pending state.
 * @param options    Stop predicate and version-mismatch hook.
 */
export function replayEvents(
  events: readonly WorkflowEvent[],
  startState: WorkflowState,
  options?: ReplayOptions,
): ReplayResult {
  let state = startState;
  const executedActionIds: ReplayedAction[] = [];
  let replayedActions = 0;
  let replayedInternals = 0;
  let lastAppliedSequenceId: number | null = null;

  for (const [index, event] of events.entries()) {
    if (options?.stopBefore?.({ event, state, index })) {
      return {
        state,
        executedActionIds,
        replayedActions,
        replayedInternals,
        lastAppliedSequenceId,
        stoppedAt: event,
      };
    }

    if (event.event_type === 'workflow_started') {
      const loggedVersion = event.internal_payload?.replay_version;
      if (loggedVersion !== undefined && loggedVersion !== REPLAY_VERSION) {
        options?.onVersionMismatch?.(loggedVersion, REPLAY_VERSION);
      }
      continue;
    }

    if (event.event_type === 'action_dispatched' && event.action) {
      state = rootReducer(state, event.action);
      const nodeId = event.node_id ?? event.action.metadata.node_id;
      executedActionIds.push({ nodeId, iterationCount: state.iteration_count });
      replayedActions++;
      lastAppliedSequenceId = event.sequence_id;
    } else if (event.event_type === 'internal_dispatched' && event.internal_type) {
      // Prefer the dispatch timestamp the live run stamped into the payload:
      // the event row's `created_at` is written later and drifts by
      // milliseconds, which would break byte-identical replay of `started_at`
      // and `updated_at`. Older logs (pre-stamp) fall back to `created_at`.
      const dispatchedAt = typeof event.internal_payload?._dispatched_at === 'string'
        ? new Date(event.internal_payload._dispatched_at)
        : event.created_at;
      const internalAction: Action = {
        id: uuidv4(),
        idempotency_key: `_replay:${event.internal_type}:${event.sequence_id}`,
        type: event.internal_type as Action['type'],
        payload: (event.internal_payload ?? {}) as Record<string, unknown>,
        metadata: { node_id: '_runner', timestamp: dispatchedAt, attempt: 1 },
      };
      state = internalReducer(state, internalAction);
      replayedInternals++;
      lastAppliedSequenceId = event.sequence_id;
    }
  }

  return {
    state,
    executedActionIds,
    replayedActions,
    replayedInternals,
    lastAppliedSequenceId,
  };
}
