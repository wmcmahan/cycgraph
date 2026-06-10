/**
 * status-transitions.test.ts — the status-transition guard
 */
import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  canTransitionStatus,
  isTerminalStatus,
  TERMINAL_STATUSES,
} from '../src/reducers/status-transitions.js';
import { setStatusReducer, internalReducer } from '../src/reducers/index.js';
import { createWorkflowState, type WorkflowState, type Action } from '../src/types/state.js';

function makeState(status: WorkflowState['status']): WorkflowState {
  return createWorkflowState({ workflow_id: uuidv4(), goal: 'g', status });
}

function setStatus(to: WorkflowState['status']): Action {
  return {
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'set_status',
    payload: { status: to },
    metadata: { node_id: 'n', timestamp: new Date(), attempt: 1 },
  };
}

describe('canTransitionStatus', () => {
  test('terminal statuses are exactly the four end states', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed', 'timeout']);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
  });

  test('blocks resurrection from a terminal state to an active one', () => {
    expect(canTransitionStatus('failed', 'running')).toBe(false);
    expect(canTransitionStatus('completed', 'running')).toBe(false);
    expect(canTransitionStatus('cancelled', 'waiting')).toBe(false);
    expect(canTransitionStatus('timeout', 'pending')).toBe(false);
  });

  test('allows terminal→terminal (saga rollback failed→cancelled)', () => {
    expect(canTransitionStatus('failed', 'cancelled')).toBe(true);
    expect(canTransitionStatus('timeout', 'cancelled')).toBe(true);
  });

  test('allows identity transitions (idempotent replay)', () => {
    expect(canTransitionStatus('failed', 'failed')).toBe(true);
    expect(canTransitionStatus('running', 'running')).toBe(true);
  });

  test('allows all transitions out of a non-terminal state', () => {
    expect(canTransitionStatus('running', 'completed')).toBe(true);
    expect(canTransitionStatus('running', 'waiting')).toBe(true);
    expect(canTransitionStatus('waiting', 'running')).toBe(true);
    expect(canTransitionStatus('pending', 'running')).toBe(true);
  });
});

describe('setStatusReducer guard', () => {
  test('a set_status on a terminal run to an active status is a no-op', () => {
    const failed = makeState('failed');
    const next = setStatusReducer(failed, setStatus('running'));
    expect(next.status).toBe('failed'); // unchanged — no resurrection
  });

  test('a legitimate active transition still applies', () => {
    const running = makeState('running');
    const next = setStatusReducer(running, setStatus('completed'));
    expect(next.status).toBe('completed');
  });
});

describe('internalReducer guard', () => {
  test('_init does not resurrect a failed run', () => {
    const failed = makeState('failed');
    const init: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: '_init' as unknown as Action['type'],
      payload: { start_node: 'n' },
      metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
    };
    expect(internalReducer(failed, init).status).toBe('failed');
  });

  test('_cancel still moves a failed run to cancelled (rollback)', () => {
    const failed = makeState('failed');
    const cancel: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: '_cancel' as unknown as Action['type'],
      payload: {},
      metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
    };
    expect(internalReducer(failed, cancel).status).toBe('cancelled');
  });
});
