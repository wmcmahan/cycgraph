/**
 * Tests for replayEvents (src/replay/replay-events.ts), the shared fold that
 * both crash recovery and forking use to reconstruct state from a run's log.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { replayEvents } from '../src/replay/replay-events.js';
import { createWorkflowState } from '../src/state/state.js';
import { REPLAY_VERSION } from '../src/state/reducers.js';
import type { WorkflowEvent } from '../src/persistence/event.js';
import type { WorkflowState } from '../src/state/state.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-01-01T00:00:00.000Z');

function baseState(): WorkflowState {
  return createWorkflowState({
    workflowId: '22222222-2222-4222-8222-222222222222',
    runId: RUN_ID,
    goal: 'g',
  });
}

let sequence = 0;

function event(partial: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'event_type'>): WorkflowEvent {
  return {
    id: uuidv4(),
    run_id: RUN_ID,
    sequence_id: sequence++,
    created_at: T0,
    ...partial,
  };
}

function writes(nodeId: string, updates: Record<string, unknown>): WorkflowEvent {
  return event({
    event_type: 'action_dispatched',
    node_id: nodeId,
    action: {
      id: uuidv4(),
      idempotency_key: `${nodeId}:0:1`,
      type: 'update_memory',
      payload: { updates },
      metadata: { node_id: nodeId, timestamp: T0, attempt: 1 },
    },
  });
}

function internal(type: string, payload?: Record<string, unknown>): WorkflowEvent {
  return event({
    event_type: 'internal_dispatched',
    internal_type: type,
    internal_payload: payload,
  });
}

function nodeStarted(nodeId: string): WorkflowEvent {
  return event({ event_type: 'node_started', node_id: nodeId });
}

function twoNodeLog(): WorkflowEvent[] {
  sequence = 0;
  return [
    event({ event_type: 'workflow_started', internal_payload: { replay_version: REPLAY_VERSION } }),
    internal('_init'),
    nodeStarted('research'),
    writes('research', { notes: 'found' }),
    internal('_increment_iteration'),
    internal('_advance', { node_id: 'write' }),
    nodeStarted('write'),
    writes('write', { draft: 'written' }),
    internal('_increment_iteration'),
    internal('_complete'),
  ];
}

describe('replayEvents', () => {
  it('folds actions into memory in log order', () => {
    const result = replayEvents(twoNodeLog(), baseState());

    expect(result.state.memory).toEqual({ notes: 'found', draft: 'written' });
  });

  it('applies internal dispatches through the internal reducer', () => {
    const result = replayEvents(twoNodeLog(), baseState());

    expect(result.state.status).toBe('completed');
    expect(result.state.iteration_count).toBe(2);
  });

  it('counts actions and internals separately', () => {
    const result = replayEvents(twoNodeLog(), baseState());

    expect(result.replayedActions).toBe(2);
    expect(result.replayedInternals).toBe(5);
  });

  it('records every applied action as a node and iteration pair', () => {
    const result = replayEvents(twoNodeLog(), baseState());

    expect(result.executedActionIds).toEqual([
      { nodeId: 'research', iterationCount: 0 },
      { nodeId: 'write', iterationCount: 1 },
    ]);
  });

  it('reports the sequence id of the last applied event', () => {
    const result = replayEvents(twoNodeLog(), baseState());

    expect(result.lastAppliedSequenceId).toBe(9);
  });

  it('leaves state untouched for an empty log', () => {
    const start = baseState();

    const result = replayEvents([], start);

    expect(result.state).toBe(start);
    expect(result.lastAppliedSequenceId).toBeNull();
  });

  it('ignores node_started events', () => {
    sequence = 0;
    const result = replayEvents([nodeStarted('research')], baseState());

    expect(result.replayedActions).toBe(0);
    expect(result.replayedInternals).toBe(0);
  });

  it('derives internal-action timestamps from the stamped dispatch time', () => {
    sequence = 0;
    const dispatchedAt = '2026-03-04T05:06:07.000Z';
    const events = [internal('_init', { _dispatched_at: dispatchedAt })];

    const result = replayEvents(events, baseState());

    expect(result.state.started_at?.toISOString()).toBe(dispatchedAt);
  });

  it('falls back to the event row timestamp when no dispatch time was stamped', () => {
    sequence = 0;
    const result = replayEvents([internal('_init')], baseState());

    expect(result.state.started_at?.toISOString()).toBe(T0.toISOString());
  });
});

describe('replayEvents — version mismatch', () => {
  it('reports a logged replay version that differs from the current one', () => {
    sequence = 0;
    const seen: Array<[unknown, number]> = [];
    const events = [
      event({ event_type: 'workflow_started', internal_payload: { replay_version: 1 } }),
    ];

    replayEvents(events, baseState(), {
      onVersionMismatch: (logged, current) => seen.push([logged, current]),
    });

    expect(seen).toEqual([[1, REPLAY_VERSION]]);
  });

  it('stays silent when the logged version matches', () => {
    sequence = 0;
    const seen: unknown[] = [];
    const events = [
      event({
        event_type: 'workflow_started',
        internal_payload: { replay_version: REPLAY_VERSION },
      }),
    ];

    replayEvents(events, baseState(), { onVersionMismatch: (logged) => seen.push(logged) });

    expect(seen).toEqual([]);
  });

  it('stays silent for a log written before versions were stamped', () => {
    sequence = 0;
    const seen: unknown[] = [];

    replayEvents([event({ event_type: 'workflow_started' })], baseState(), {
      onVersionMismatch: (logged) => seen.push(logged),
    });

    expect(seen).toEqual([]);
  });
});

describe('replayEvents — stopBefore', () => {
  it('excludes the event it halts on', () => {
    const events = twoNodeLog();

    const result = replayEvents(events, baseState(), {
      stopBefore: ({ event: e }) => e.event_type === 'node_started' && e.node_id === 'write',
    });

    expect(result.state.memory).toEqual({ notes: 'found' });
  });

  it('reconstructs the state the halted-on node was about to read', () => {
    const events = twoNodeLog();

    const result = replayEvents(events, baseState(), {
      stopBefore: ({ event: e }) => e.event_type === 'node_started' && e.node_id === 'write',
    });

    expect(result.state.current_node).toBe('write');
    expect(result.state.iteration_count).toBe(1);
  });

  it('returns the event it halted on', () => {
    const events = twoNodeLog();

    const result = replayEvents(events, baseState(), {
      stopBefore: ({ event: e }) => e.sequence_id === 6,
    });

    expect(result.stoppedAt?.sequence_id).toBe(6);
    expect(result.lastAppliedSequenceId).toBe(5);
  });

  it('replays the whole log when the predicate never fires', () => {
    const result = replayEvents(twoNodeLog(), baseState(), { stopBefore: () => false });

    expect(result.stoppedAt).toBeUndefined();
    expect(result.state.memory).toEqual({ notes: 'found', draft: 'written' });
  });

  it('passes the pre-event state to the predicate', () => {
    const events = twoNodeLog();
    const seen: Array<Record<string, unknown>> = [];

    replayEvents(events, baseState(), {
      stopBefore: ({ event: e, state }) => {
        if (e.sequence_id === 6) seen.push(state.memory);
        return false;
      },
    });

    expect(seen).toEqual([{ notes: 'found' }]);
  });

  it('halts before applying anything when the first event matches', () => {
    const start = baseState();

    const result = replayEvents(twoNodeLog(), start, { stopBefore: ({ index }) => index === 0 });

    expect(result.state).toBe(start);
    expect(result.replayedActions).toBe(0);
  });
});
