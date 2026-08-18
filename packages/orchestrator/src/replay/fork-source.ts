/**
 * Fork sources
 *
 * Where a fork's starting state comes from. Two substrates exist, and they
 * fail in different places.
 *
 * **Events** replay the log through the reducers. Precise: any node boundary
 * is addressable, and the reconstructed state is bit-for-bit the state the run
 * held. Bounded by compaction, which deletes events behind the newest
 * checkpoint — on by default at 1000 events.
 *
 * **Snapshots** read a persisted `workflow_states` row. One exists per step and
 * they survive compaction, so this is the only way into a long run's early
 * history. Less precise: a snapshot is written after a node's action reduces
 * but before `_increment_iteration` and `_advance`, so it can sit inside a
 * node's event group.
 *
 * That imprecision has no event-free fix. `_advance` sets `current_node` and
 * appends to `visited_nodes` in the same reduction, so neither field says
 * whether the current node has executed yet, and `_last_event_sequence_id` is
 * uninterpretable once the events behind it are gone.
 *
 * So a snapshot fork takes the one reading that is coherent either way:
 * **re-execute `current_node`**. When the snapshot sits after an advance that
 * is exactly right, and when it sits mid-group it is `beforeNode(current_node)`
 * with that node's previous output still in memory until it overwrites it.
 * Callers are told which they got, because the difference shows up in a diff.
 *
 * @module replay/fork-source
 */

import type { WorkflowState } from '../state/state.js';
import { hydrateWorkflowState } from '../state/state.js';
import type { EventLogWriter } from '../persistence/event-log.js';
import type { PersistenceProvider } from '../persistence/interfaces.js';
import type { WorkflowEvent } from '../persistence/event.js';
import { ForkError } from './errors.js';

/** Which substrate a fork reads its starting state from. */
export type ForkSourceKind = 'events' | 'snapshot';

/** One addressable snapshot of a run. */
export interface SnapshotPoint {
  /** Version to pass as `{ version }`. */
  version: number;
  /** Node the run was on. */
  nodeId: string | null;
  /** Run status at that point. */
  status: string;
  /** When the snapshot was written. */
  createdAt: Date;
}

/** Everything a fork needs about the run it is forking. */
export interface ForkSource {
  kind: ForkSourceKind;
  /** The base run's events. Empty for a snapshot source. */
  events: WorkflowEvent[];
  /** The base run's final state, the other side of the diff. */
  baseState: WorkflowState;
}

/** Load a run's addressable snapshot versions, newest last. */
export async function snapshotPoints(
  runId: string,
  persistence: PersistenceProvider,
): Promise<SnapshotPoint[]> {
  const history = await persistence.loadWorkflowStateHistory(runId, { limit: 1000 });
  return history
    .map(row => ({
      version: row.version,
      nodeId: row.current_node,
      status: row.status,
      createdAt: row.created_at,
    }))
    .sort((a, b) => a.version - b.version);
}

/** Read the state at one snapshot version. */
export async function loadSnapshotState(
  runId: string,
  version: number,
  persistence: PersistenceProvider,
): Promise<WorkflowState> {
  const raw = await persistence.loadWorkflowStateAtVersion(runId, version);
  if (!raw) {
    const available = await snapshotPoints(runId, persistence);
    const versions = available.length > 0
      ? `Available: ${available[0].version}..${available[available.length - 1].version}.`
      : 'This run has no persisted snapshots.';
    throw new ForkError(`fork(${runId}): no state snapshot at version ${version}. ${versions}`);
  }
  return hydrateWorkflowState(raw);
}

/**
 * Decide which substrate to read, and load what it needs.
 *
 * `'auto'` prefers events for their precision and falls back to snapshots when
 * the log is gone. Being explicit is better when it matters: a caller who
 * needs an exact node boundary should ask for `'events'` and get an error
 * rather than a silently coarser fork.
 */
export async function resolveForkSource(
  runId: string,
  options: {
    kind?: ForkSourceKind | 'auto';
    eventLog?: EventLogWriter;
    persistence?: PersistenceProvider;
    /** Builds the seed state a full event replay folds onto. */
    replayBase: (events: readonly WorkflowEvent[]) => WorkflowState;
  },
): Promise<ForkSource> {
  const kind = options.kind ?? 'auto';
  const events = options.eventLog ? await options.eventLog.loadEvents(runId) : [];

  if (kind !== 'snapshot' && events.length > 0) {
    return { kind: 'events', events, baseState: options.replayBase(events) };
  }

  if (kind === 'events') {
    throw new ForkError(
      `fork(${runId}): no recorded events. Forking from events replays the run's log, so the run ` +
      `must have been executed with an event log wired — runRecorded() does that, and run() does ` +
      `not. If the log was compacted away, pass a persistence provider and source: 'snapshot'.`,
    );
  }

  if (!options.persistence) {
    throw new ForkError(
      `fork(${runId}): no recorded events and no persistence provider, so there is nothing to ` +
      `fork from. Record the run with runRecorded(), or pass persistence for a snapshot fork.`,
    );
  }

  const baseState = await options.persistence.loadLatestWorkflowState(runId);
  if (!baseState) {
    throw new ForkError(
      `fork(${runId}): no events and no state snapshots. This run left no trace to fork.`,
    );
  }

  return { kind: 'snapshot', events, baseState: hydrateWorkflowState(baseState) };
}
