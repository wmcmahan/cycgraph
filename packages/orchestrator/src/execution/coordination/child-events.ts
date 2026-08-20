/**
 * Child event threading
 *
 * A subgraph child runs on its own {@link GraphRunner}, which records its
 * execution through whatever `EventLogWriter` it is given. Handing it the
 * parent's writer directly would interleave two runs' sequence spaces;
 * giving it none makes the child a black box in the replay-bearing log.
 * {@link childEventLogWriter} is the third option: an adapter that
 * translates each child event into a `child_*` event in the PARENT's log —
 * forwarded through the parent's coordinator, which owns sequence
 * assignment, so child events land contiguously inside the subgraph node's
 * own event group (the parent loop is blocked while the child runs).
 *
 * Translation rules:
 * - `workflow_started/node_started/action_dispatched/internal_dispatched`
 *   become their `child_*` counterparts; `state_persisted` markers are
 *   dropped (the parent's own persistence marks durability).
 * - Already-`child_*` events (a grandchild coming through a nested wrapper)
 *   keep their type and gain another node-id prefix, so nesting composes.
 * - `node_id` is prefixed with the subgraph node's id: `edit/locate`.
 * - `internal_payload._child_run_id` carries the run id the event was
 *   authored under, preserved across nesting hops — the parent coordinator
 *   restamps `run_id`, so this is the only surviving child-run identity.
 *
 * Checkpoints and compaction are refused by omission: a child must never
 * checkpoint the parent's slot or delete the parent's history. Reads return
 * empty — a child never recovers from this adapter; HITL resume travels via
 * the parent's `subgraph_checkpoints` stash instead.
 *
 * @module execution/coordination/child-events
 */

import type { EventType, NewWorkflowEvent, WorkflowEvent } from '../../persistence/event.js';
import type { EventLogWriter } from '../../persistence/event-log.js';
import type { WorkflowState } from '../../state/state.js';
import type { AppendEventOptions } from './event-log-coordinator.js';

/**
 * The parent runner's append facility, closed over its own coordinator so
 * sequence assignment stays single-writer.
 */
export type ChildEventSink = (event_type: EventType, opts: AppendEventOptions) => void;

const CHILD_TYPE: Partial<Record<EventType, EventType>> = {
  workflow_started: 'child_workflow_started',
  node_started: 'child_node_started',
  action_dispatched: 'child_action_dispatched',
  internal_dispatched: 'child_internal_dispatched',
  child_workflow_started: 'child_workflow_started',
  child_node_started: 'child_node_started',
  child_action_dispatched: 'child_action_dispatched',
  child_internal_dispatched: 'child_internal_dispatched',
};

/**
 * An `EventLogWriter` for a subgraph child that records into the parent's
 * log as `child_*` events under the subgraph node's namespace.
 */
export function childEventLogWriter(
  sink: ChildEventSink,
  subgraphNodeId: string,
): EventLogWriter {
  return {
    async append(event: NewWorkflowEvent): Promise<void> {
      const type = CHILD_TYPE[event.event_type];
      if (!type) return;

      const childRunId =
        (event.internal_payload?.['_child_run_id'] as string | undefined) ?? event.run_id;

      sink(type, {
        node_id: event.node_id ? `${subgraphNodeId}/${event.node_id}` : subgraphNodeId,
        ...(event.action ? { action: event.action } : {}),
        ...(event.internal_type ? { internal_type: event.internal_type } : {}),
        internal_payload: {
          ...(event.internal_payload ?? {}),
          _child_run_id: childRunId,
        },
      });
    },

    async loadEvents(): Promise<WorkflowEvent[]> {
      return [];
    },
    async loadEventsAfter(): Promise<WorkflowEvent[]> {
      return [];
    },
    async getLatestSequenceId(): Promise<number> {
      return -1;
    },
    async checkpoint(_runId: string, _sequenceId: number, _state: WorkflowState): Promise<void> {
      // A child never checkpoints the parent's slot.
    },
    async loadCheckpoint(): Promise<{ sequence_id: number; state: WorkflowState } | null> {
      return null;
    },
    async compact(): Promise<number> {
      return 0;
    },
  };
}
