import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  requestHumanInputReducer,
  resumeFromHumanReducer,
  mergeParallelResultsReducer,
  rootReducer,
  validateAction,
  handoffReducer,
  MAX_SUPERVISOR_HISTORY,
} from '../src/reducers/index.js';
import type { WorkflowState, Action } from '../src/types/state.js';

const createBaseState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test goal',
  constraints: [],
  status: 'running',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const makeAction = (type: string, payload: Record<string, unknown>): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type,
  payload,
  metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
});

describe('Tier 2 Reducers', () => {
  describe('requestHumanInputReducer', () => {
    test('should set status to waiting', () => {
      const state = createBaseState();
      const action = makeAction('request_human_input', {
        waiting_for: 'human_approval',
        timeout_ms: 60000,
        pending_approval: { node_id: 'review', prompt_message: 'Review this' },
      });

      const newState = requestHumanInputReducer(state, action);

      expect(newState.status).toBe('waiting');
      expect(newState.waiting_for).toBe('human_approval');
      expect(newState.waiting_since).toBeInstanceOf(Date);
      expect(newState.waiting_timeout_at).toBeInstanceOf(Date);
      expect(newState.memory._pending_approval).toEqual({
        node_id: 'review',
        prompt_message: 'Review this',
      });
    });

    test('should use default timeout when not specified', () => {
      const state = createBaseState();
      const action = makeAction('request_human_input', {
        waiting_for: 'human_approval',
        pending_approval: { node_id: 'review' },
      });

      const newState = requestHumanInputReducer(state, action);

      // Default is 24 hours
      const diff = newState.waiting_timeout_at!.getTime() - newState.waiting_since!.getTime();
      expect(diff).toBe(86_400_000);
    });

    test('should not mutate original state', () => {
      const state = createBaseState();
      const action = makeAction('request_human_input', {
        waiting_for: 'human_approval',
        pending_approval: {},
      });

      const newState = requestHumanInputReducer(state, action);
      expect(newState).not.toBe(state);
      expect(state.status).toBe('running');
    });

    test('should ignore non-matching action types', () => {
      const state = createBaseState();
      const action = makeAction('update_memory', { updates: {} });
      const newState = requestHumanInputReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('resumeFromHumanReducer', () => {
    test('should set status back to running and inject response', () => {
      const state = createBaseState();
      state.status = 'waiting';
      state.waiting_for = 'human_approval';
      state.waiting_since = new Date();
      state.waiting_timeout_at = new Date();
      state.memory._pending_approval = { node_id: 'review' };

      const action = makeAction('resume_from_human', {
        decision: 'approved',
        response: 'Looks good',
      });

      const newState = resumeFromHumanReducer(state, action);

      expect(newState.status).toBe('running');
      expect(newState.waiting_for).toBeUndefined();
      expect(newState.waiting_since).toBeUndefined();
      expect(newState.waiting_timeout_at).toBeUndefined();
      expect(newState.memory.human_response).toBe('Looks good');
      expect(newState.memory.human_decision).toBe('approved');
      expect(newState.memory._pending_approval).toBeUndefined();
    });

    test('should merge additional memory_updates', () => {
      const state = createBaseState();
      state.status = 'waiting';
      state.memory._pending_approval = {};

      const action = makeAction('resume_from_human', {
        decision: 'edited',
        response: 'Changed output',
        memory_updates: { edited_field: 'new value' },
      });

      const newState = resumeFromHumanReducer(state, action);
      expect(newState.memory.edited_field).toBe('new value');
      expect(newState.memory.human_decision).toBe('edited');
    });

    test('should ignore non-matching action types', () => {
      const state = createBaseState();
      const action = makeAction('update_memory', { updates: {} });
      const newState = resumeFromHumanReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('mergeParallelResultsReducer', () => {
    test('should merge updates but NOT add token count (runner _track_tokens is sole accountant)', () => {
      const state = createBaseState();
      state.total_tokens_used = 100;

      const action = makeAction('merge_parallel_results', {
        updates: { map1_results: ['a', 'b'], map1_count: 2 },
        total_tokens: 500,
      });

      const newState = mergeParallelResultsReducer(state, action);

      expect(newState.memory.map1_results).toEqual(['a', 'b']);
      expect(newState.memory.map1_count).toBe(2);
      // The runner dispatches a separate _track_tokens for the same action, so
      // adding total_tokens here too would double-count. Reducer leaves it.
      expect(newState.total_tokens_used).toBe(100);
    });

    test('leaves token total untouched regardless of payload total_tokens', () => {
      const state = createBaseState();
      state.total_tokens_used = 50;

      const action = makeAction('merge_parallel_results', {
        updates: { result: 'ok' },
        total_tokens: 0,
      });

      const newState = mergeParallelResultsReducer(state, action);
      expect(newState.total_tokens_used).toBe(50);
    });

    test('should not mutate original state', () => {
      const state = createBaseState();
      const action = makeAction('merge_parallel_results', {
        updates: { key: 'val' },
        total_tokens: 10,
      });

      const newState = mergeParallelResultsReducer(state, action);
      expect(newState).not.toBe(state);
      expect(state.memory.key).toBeUndefined();
    });
  });

  describe('rootReducer with new types', () => {
    test('should process request_human_input through rootReducer', () => {
      const state = createBaseState();
      const action = makeAction('request_human_input', {
        waiting_for: 'human_approval',
        pending_approval: { node_id: 'n1' },
      });

      const newState = rootReducer(state, action);
      expect(newState.status).toBe('waiting');
    });

    test('should process merge_parallel_results through rootReducer', () => {
      const state = createBaseState();
      const action = makeAction('merge_parallel_results', {
        updates: { data: [1, 2, 3] },
        total_tokens: 100,
      });

      const newState = rootReducer(state, action);
      expect(newState.memory.data).toEqual([1, 2, 3]);
      // Token accounting is the runner's _track_tokens job, not the reducer's.
      expect(newState.total_tokens_used).toBe(0);
    });
  });

  describe('validateAction with new types', () => {
    test('should allow request_human_input with control_flow permission', () => {
      const action = makeAction('request_human_input', { waiting_for: 'human_approval' });
      expect(validateAction(action, ['control_flow'])).toBe(true);
    });

    test('should block request_human_input without control_flow', () => {
      const action = makeAction('request_human_input', { waiting_for: 'human_approval' });
      expect(validateAction(action, ['result'])).toBe(false);
    });

    test('should allow resume_from_human with control_flow permission', () => {
      const action = makeAction('resume_from_human', { decision: 'approved' });
      expect(validateAction(action, ['control_flow'])).toBe(true);
    });

    test('should validate merge_parallel_results keys', () => {
      const action = makeAction('merge_parallel_results', {
        updates: { allowed_key: 'val' },
      });
      expect(validateAction(action, ['allowed_key'])).toBe(true);
    });

    test('should block merge_parallel_results with unauthorized keys', () => {
      const action = makeAction('merge_parallel_results', {
        updates: { forbidden: 'val' },
      });
      expect(validateAction(action, ['other_key'])).toBe(false);
    });

    test('should allow all new types with wildcard', () => {
      for (const type of ['request_human_input', 'resume_from_human', 'merge_parallel_results']) {
        const action = makeAction(type, { updates: { key: 'val' } });
        expect(validateAction(action, ['*'])).toBe(true);
      }
    });
  });

  describe('MAX_SUPERVISOR_HISTORY', () => {
    test('should preserve history at exactly MAX_SUPERVISOR_HISTORY entries', () => {
      const state = createBaseState();
      // Pre-fill with MAX_SUPERVISOR_HISTORY - 1 entries so the next handoff hits exactly the limit
      state.supervisor_history = Array.from({ length: MAX_SUPERVISOR_HISTORY - 1 }, (_, i) => ({
        supervisor_id: 'sup',
        delegated_to: `node-${i}`,
        reasoning: `reason-${i}`,
        iteration: i,
        timestamp: new Date(),
      }));

      const action = makeAction('handoff', {
        node_id: 'final-node',
        supervisor_id: 'sup',
        reasoning: 'final reason',
      });

      const newState = handoffReducer(state, action);

      expect(newState.supervisor_history).toHaveLength(MAX_SUPERVISOR_HISTORY);
      // The last entry should be the one we just added
      expect(newState.supervisor_history[MAX_SUPERVISOR_HISTORY - 1].delegated_to).toBe('final-node');
      // The first entry should still be the original first entry
      expect(newState.supervisor_history[0].delegated_to).toBe('node-0');
    });

    test('should trim history beyond MAX_SUPERVISOR_HISTORY, keeping newest entries', () => {
      const state = createBaseState();
      // Pre-fill with exactly MAX_SUPERVISOR_HISTORY entries so the next handoff exceeds the limit
      state.supervisor_history = Array.from({ length: MAX_SUPERVISOR_HISTORY }, (_, i) => ({
        supervisor_id: 'sup',
        delegated_to: `node-${i}`,
        reasoning: `reason-${i}`,
        iteration: i,
        timestamp: new Date(),
      }));

      const action = makeAction('handoff', {
        node_id: 'overflow-node',
        supervisor_id: 'sup',
        reasoning: 'overflow reason',
      });

      const newState = handoffReducer(state, action);

      expect(newState.supervisor_history).toHaveLength(MAX_SUPERVISOR_HISTORY);
      // The oldest entry (node-0) should have been dropped
      expect(newState.supervisor_history[0].delegated_to).toBe('node-1');
      // The newest entry should be at the end
      expect(newState.supervisor_history[MAX_SUPERVISOR_HISTORY - 1].delegated_to).toBe('overflow-node');
    });

    test('should not affect history below the limit', () => {
      const state = createBaseState();
      state.supervisor_history = [
        {
          supervisor_id: 'sup',
          delegated_to: 'node-a',
          reasoning: 'first',
          iteration: 0,
          timestamp: new Date(),
        },
      ];

      const action = makeAction('handoff', {
        node_id: 'node-b',
        supervisor_id: 'sup',
        reasoning: 'second',
      });

      const newState = handoffReducer(state, action);

      expect(newState.supervisor_history).toHaveLength(2);
      expect(newState.supervisor_history[0].delegated_to).toBe('node-a');
      expect(newState.supervisor_history[1].delegated_to).toBe('node-b');
    });
  });
});
