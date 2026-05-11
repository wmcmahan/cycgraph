/**
 * Workflow Recovery
 *
 * Reconstructs a `GraphRunner` from its event log via deterministic replay.
 * Used by `WorkflowWorker` for crash recovery and by the public
 * `GraphRunner.recover()` static method (which delegates here).
 *
 * Algorithm:
 *   1. Load the most recent checkpoint, if any. Replay only events after it.
 *   2. Otherwise load every event and verify a `_init` was the first
 *      internal_dispatched — otherwise the log is corrupt.
 *   3. Build a runner with the start state (checkpoint or minimal).
 *   4. Replay events through the same `rootReducer` / `internalReducer` used
 *      at runtime. No LLM calls — the stored `Action` objects already contain
 *      the agent outputs.
 *   5. Atomically rehydrate the runner with the final state,
 *      idempotency Set, and next sequenceId.
 *
 * The atomic rehydrate (single `_rehydrate` call) is critical: applying
 * state/idempotency/sequenceId separately would let a consumer observe
 * partially-recovered state.
 *
 * @module runner/recover
 */

import { v4 as uuidv4 } from 'uuid';
import type { Graph } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import { rootReducer, internalReducer } from '../reducers/index.js';
import type { EventLogWriter } from '../db/event-log.js';
import type { WorkflowEvent } from '../types/event.js';
import { EventLogCorruptionError } from './errors.js';
import { createLogger } from '../utils/logger.js';
import { GraphRunner, type GraphRunnerOptions } from './graph-runner.js';

const logger = createLogger('runner.recover');

/**
 * Recover a workflow run from its event log via deterministic replay.
 *
 * @param graph     The graph definition to execute against.
 * @param runId     The workflow run_id to recover.
 * @param eventLog  The event log writer to load events from.
 * @param options   Optional persistence/graph loading functions.
 * @returns         A GraphRunner ready to continue execution via `.run()`.
 *
 * @throws {EventLogCorruptionError} If no events exist or the log is missing
 *   the `_init` event.
 */
export async function recoverGraphRunner(
  graph: Graph,
  runId: string,
  eventLog: EventLogWriter,
  options?: Omit<GraphRunnerOptions, 'eventLog'>,
): Promise<GraphRunner> {
  // 1. Check for a checkpoint first (fast path for compacted logs).
  const checkpoint = await eventLog.loadCheckpoint(runId);

  let events: WorkflowEvent[];
  let startState: WorkflowState;

  if (checkpoint) {
    events = await eventLog.loadEventsAfter(runId, checkpoint.sequence_id);
    startState = checkpoint.state;

    logger.info('recovery_from_checkpoint', {
      run_id: runId,
      checkpoint_sequence_id: checkpoint.sequence_id,
      events_after_checkpoint: events.length,
    });
  } else {
    events = await eventLog.loadEvents(runId);
    if (events.length === 0) {
      throw new EventLogCorruptionError(runId);
    }

    // The log must start with an `_init` internal dispatch — otherwise we
    // cannot trust the sequence we're replaying.
    const initEvent = events.find(
      e => e.event_type === 'internal_dispatched' && e.internal_type === '_init',
    );
    if (!initEvent) {
      throw new EventLogCorruptionError(runId);
    }

    // Minimal pending state the reducers will transform into the
    // reconstructed state.
    startState = {
      workflow_id: graph.id,
      run_id: runId,
      status: 'pending',
      goal: '',
      constraints: [],
      memory: {},
      iteration_count: 0,
      retry_count: 0,
      max_retries: 3,
      total_tokens_used: 0,
      total_cost_usd: 0,
      _cost_alert_thresholds_fired: [],
      visited_nodes: [],
      max_iterations: 50,
      max_execution_time_ms: 3600000,
      compensation_stack: [],
      supervisor_history: [],
      memory_drops: [],
      created_at: events[0].created_at,
      updated_at: events[0].created_at,
    };

    logger.info('recovery_started', {
      run_id: runId,
      event_count: events.length,
      last_sequence_id: events[events.length - 1].sequence_id,
    });
  }

  const runner = new GraphRunner(graph, startState, {
    ...options,
    eventLog,
  });

  // 2. Replay events through the same reducers used at runtime.
  // The runner's initial state is the same `startState` we passed it.
  let state: WorkflowState = startState;
  const executedActionIds: Array<{ nodeId: string; iterationCount: number }> = [];
  let replayedActions = 0;
  let replayedInternals = 0;

  for (const event of events) {
    if (event.event_type === 'action_dispatched' && event.action) {
      state = rootReducer(state, event.action);
      const nodeId = event.node_id ?? event.action.metadata.node_id;
      executedActionIds.push({ nodeId, iterationCount: state.iteration_count });
      replayedActions++;
    } else if (event.event_type === 'internal_dispatched' && event.internal_type) {
      const internalAction: Action = {
        id: uuidv4(),
        idempotency_key: `_replay:${event.internal_type}:${event.sequence_id}`,
        type: event.internal_type as Action['type'],
        payload: (event.internal_payload ?? {}) as Record<string, unknown>,
        metadata: { node_id: '_runner', timestamp: event.created_at, attempt: 1 },
      };
      state = internalReducer(state, internalAction);
      replayedInternals++;
    }
  }

  // 3. Atomically rehydrate the runner — state, idempotency keys, and the
  // next sequenceId apply in a single call so no consumer sees half-recovered
  // state. Critical: passing these three to separate setters would create
  // observable intermediate states.
  const lastSeq = events.length > 0
    ? events[events.length - 1].sequence_id
    : checkpoint?.sequence_id ?? -1;
  runner._rehydrate({
    state,
    executedActionIds,
    nextSequenceId: lastSeq + 1,
  });

  logger.info('recovery_complete', {
    run_id: runId,
    from_checkpoint: !!checkpoint,
    replayed_actions: replayedActions,
    replayed_internals: replayedInternals,
    recovered_status: state.status,
    recovered_node: state.current_node,
    recovered_iteration: state.iteration_count,
  });

  return runner;
}
