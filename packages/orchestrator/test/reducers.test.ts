import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  updateMemoryReducer,
  setStatusReducer,
  gotoNodeReducer,
  handoffReducer,
  requestHumanInputReducer,
  internalReducer,
  rootReducer,
  validateAction,
  MAX_VISITED_NODES,
} from '../src/reducers/index.js';
import type { WorkflowState, Action } from '../src/types/state.js';

describe('Reducers', () => {
  const createBaseState = (): WorkflowState => ({
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'Test goal',
    constraints: [],
    status: 'pending',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3600000,
    total_tokens_used: 0,
    total_cost_usd: 0,
    _cost_alert_thresholds_fired: [],
    supervisor_history: [],
    memory_drops: [],
  });

  describe('updateMemoryReducer', () => {
    it('updates memory with new values', () => {
      const state = createBaseState();
      state.memory = { count: 1, name: 'test' };

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: {
          updates: { count: 2, color: 'blue' },
        },
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState.memory.count).toBe(2);
      expect(newState.memory.color).toBe('blue');
      expect(newState.memory.name).toBe('test');
      expect(newState.updated_at).not.toBe(state.updated_at);
    });

    it('does not mutate original state', () => {
      const state = createBaseState();
      state.memory = { count: 1 };

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { count: 2 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState).not.toBe(state);
      expect(newState.memory).not.toBe(state.memory);
      expect(state.memory.count).toBe(1);
    });

    it('ignores non-update_memory actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState).toBe(state);
    });
  });

  describe('setStatusReducer', () => {
    it('updates workflow status', () => {
      const state = createBaseState();
      state.status = 'pending';

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = setStatusReducer(state, action);

      expect(newState.status).toBe('running');
      expect(newState.updated_at).not.toBe(state.updated_at);
    });

    it('handles all valid statuses', () => {
      const statuses = [
        'pending',
        'scheduled',
        'running',
        'waiting',
        'retrying',
        'completed',
        'failed',
        'cancelled',
        'timeout',
      ] as const;

      for (const status of statuses) {
        const state = createBaseState();
        const action: Action = {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'set_status',
          payload: { status },
          metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
        };

        const newState = setStatusReducer(state, action);
        expect(newState.status).toBe(status);
      }
    });

    it('ignores non-set_status actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: {} },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = setStatusReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('gotoNodeReducer', () => {
    it('updates current_node and track visited nodes', () => {
      const state = createBaseState();
      state.current_node = 'node1';
      state.visited_nodes = ['node1'];
      state.iteration_count = 1;

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'node2' },
        metadata: { node_id: 'node1', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.current_node).toBe('node2');
      expect(newState.visited_nodes).toEqual(['node1', 'node2']);
      expect(newState.iteration_count).toBe(1);
    });

    it('increments iteration count', () => {
      const state = createBaseState();
      state.iteration_count = 5;

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'next' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);
      expect(newState.iteration_count).toBe(5);
    });

    it('ignores non-goto_node actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: {} },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('rootReducer', () => {
    it('applies all reducers in sequence', () => {
      const state = createBaseState();
      state.status = 'pending';
      state.memory = {};

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'success' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = rootReducer(state, action);

      expect(newState.memory.result).toBe('success');
    });

    it('is composable', () => {
      let state = createBaseState();

      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { step: 1 } },
        metadata: { node_id: 'n1', timestamp: new Date(), attempt: 1 },
      });

      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'n2' },
        metadata: { node_id: 'n1', timestamp: new Date(), attempt: 1 },
      });

      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'n2', timestamp: new Date(), attempt: 1 },
      });

      expect(state.memory.step).toBe(1);
      expect(state.current_node).toBe('n2');
      expect(state.status).toBe('running');
      expect(state.iteration_count).toBe(0);
    });
  });

  describe('bounded visited_nodes', () => {
    it('caps visited_nodes at MAX_VISITED_NODES via gotoNodeReducer', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'overflow' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    it('caps visited_nodes at MAX_VISITED_NODES via handoffReducer', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'handoff',
        payload: { node_id: 'overflow', supervisor_id: 'sup', reasoning: 'test' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = handoffReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    it('caps visited_nodes via _advance internal action', () => {
      const state = createBaseState();
      state.status = 'running';
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: '_advance',
        payload: { node_id: 'overflow' },
        metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
      };

      const newState = internalReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    it('caps visited_nodes via _init internal action', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: '_init',
        payload: { start_node: 'overflow' },
        metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
      };

      const newState = internalReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    it('does not truncate when under the cap', () => {
      const state = createBaseState();
      state.visited_nodes = ['a', 'b'];

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'c' },
        metadata: { node_id: 'b', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.visited_nodes).toEqual(['a', 'b', 'c']);
    });
  });

  describe('validateAction', () => {
    it('allows wildcard permissions', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { secret: 'data' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['*']);
      expect(isValid).toBe(true);
    });

    it('allows writes to permitted keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', count: 5 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result', 'count']);
      expect(isValid).toBe(true);
    });

    it('blocks writes to unpermitted keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { secret: 'data' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result', 'count']);
      expect(isValid).toBe(false);
    });

    it('blocks partial unauthorized writes', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', secret: 'bad' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result']);
      expect(isValid).toBe(false);
    });

    it('blocks non-update_memory actions without explicit permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, []);
      expect(isValid).toBe(false);
    });

    it('allows set_status with status permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['status']);
      expect(isValid).toBe(true);
    });

    it('allows goto_node with control_flow permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'next' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['control_flow']);
      expect(isValid).toBe(true);
    });

    it('blocks unknown action types even with wildcard', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'unknown_type',
        payload: {},
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['*']);
      expect(isValid).toBe(false);
    });

    it('skips _-prefixed system keys during validation (executor handles agent blocking)', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { _taint_registry: { source: 'mcp_tool' } } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
      expect(validateAction(action, ['some_key'])).toBe(true);
    });

    it('allows wildcard write to normal keys via update_memory', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', count: 5 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
    });

    it('skips _-prefixed keys in merge_parallel_results', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: { updates: { result: 'ok', _internal: 'system' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
    });

    it('allows merge_parallel_results with normal keys and wildcard', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: { updates: { result: 'ok' }, total_tokens: 100 },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
    });

    it('validates user keys alongside _-prefixed system keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { _taint_registry: {}, normal: 'ok' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['normal'])).toBe(true);
      expect(validateAction(action, ['other_key'])).toBe(false);
    });
  });

  describe('Memory value size validation', () => {
    it('drops oversized memory values in updateMemoryReducer and records them in state.memory_drops', () => {
      const state = createBaseState();
      const oversizedValue = 'x'.repeat(1024 * 1024 + 1);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: {
          updates: {
            normal_key: 'normal_value',
            oversized_key: oversizedValue,
          },
        },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.normal_key).toBe('normal_value');
      expect(newState.memory.oversized_key).toBeUndefined();
      expect(newState.memory_drops).toHaveLength(1);
      expect(newState.memory_drops[0]).toMatchObject({
        key: 'oversized_key',
        reason: 'oversized',
        node_id: 'test',
      });
      expect(newState.memory_drops[0].bytes).toBeGreaterThan(1024 * 1024);
    });

    it('drops oversized values in mergeParallelResultsReducer and records them in state.memory_drops', () => {
      const state = createBaseState();
      const oversizedValue = 'y'.repeat(1024 * 1024 + 1);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: {
          updates: {
            good: 'ok',
            big: oversizedValue,
          },
          total_tokens: 100,
        },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = rootReducer(state, action);
      expect(newState.memory.good).toBe('ok');
      expect(newState.memory.big).toBeUndefined();
      expect(newState.memory_drops).toHaveLength(1);
      expect(newState.memory_drops[0]).toMatchObject({ key: 'big', reason: 'oversized' });
    });

    it('mergeParallelResultsReducer does NOT add tokens (runner _track_tokens is sole accountant)', () => {
      const state = { ...createBaseState(), total_tokens_used: 500 };
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: { updates: { r: 'ok' }, total_tokens: 90 },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };
      const newState = rootReducer(state, action);
      expect(newState.total_tokens_used).toBe(500);
      expect(newState.memory.r).toBe('ok');
    });

    it('mergeParallelResultsReducer merges _taint_registry append-only', () => {
      const state: WorkflowState = {
        ...createBaseState(),
        memory: {},
        taint_registry: { existing_key: { source: 'mcp_tool', created_at: 't0' } },
      };
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: {
          updates: {
            node_results: [{ index: 0 }],
            _taint_registry: { node_results: { source: 'derived', agent_id: 'fanout', created_at: 't1' } },
          },
        },
        metadata: { node_id: 'fanout', timestamp: new Date(), attempt: 1 },
      };
      const newState = rootReducer(state, action);
      const registry = newState.taint_registry as Record<string, unknown>;
      expect(registry.existing_key).toBeDefined();
      expect(registry.node_results).toMatchObject({ source: 'derived' });
    });

    it('records non-serializable values as memory drops', () => {
      const state = createBaseState();
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { circular } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.circular).toBeUndefined();
      expect(newState.memory_drops).toHaveLength(1);
      expect(newState.memory_drops[0]).toMatchObject({ key: 'circular', reason: 'non_serializable' });
      expect(newState.memory_drops[0].bytes).toBeUndefined();
    });

    it('memory_drops ring buffer is bounded to MAX_MEMORY_DROPS', () => {
      let state = createBaseState();
      const oversizedValue = 'x'.repeat(1024 * 1024 + 1);

      for (let i = 0; i < 55; i++) {
        const action: Action = {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [`drop_${i}`]: oversizedValue } },
          metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
        };
        state = updateMemoryReducer(state, action);
      }

      expect(state.memory_drops).toHaveLength(50);
      expect(state.memory_drops[0].key).toBe('drop_5');
      expect(state.memory_drops[49].key).toBe('drop_54');
    });

    it('allows values within the size limit', () => {
      const state = createBaseState();
      const normalValue = 'x'.repeat(1000);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { key: normalValue } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.key).toBe(normalValue);
    });
  });
});

describe('Replay determinism — reducers derive time from action metadata', () => {
  const makeState = (): WorkflowState => ({
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    goal: 'Test goal',
    constraints: [],
    status: 'pending',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3600000,
    total_tokens_used: 0,
    total_cost_usd: 0,
    _cost_alert_thresholds_fired: [],
    supervisor_history: [],
    memory_drops: [],
  });

  const FIXED_TS = new Date('2026-03-15T12:00:00.000Z');

  const makeAction = (type: Action['type'], payload: Record<string, unknown>, timestamp: Date | string = FIXED_TS): Action => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type,
    payload,
    metadata: { node_id: 'test-node', timestamp: timestamp as Date, attempt: 1 },
  });

  it('request_human_input reproduces the original approval deadline on replay', () => {
    const action = makeAction('request_human_input', {
      timeout_ms: 60_000,
      pending_approval: { node_id: 'gate' },
    });

    const replayed = requestHumanInputReducer(makeState(), action);
    expect(replayed.waiting_since).toEqual(FIXED_TS);
    expect(replayed.waiting_timeout_at).toEqual(new Date(FIXED_TS.getTime() + 60_000));
  });

  it('request_human_input tolerates string timestamps from JSON round-trips', () => {
    const action = makeAction(
      'request_human_input',
      { timeout_ms: 60_000, pending_approval: {} },
      FIXED_TS.toISOString(),
    );

    const replayed = requestHumanInputReducer(makeState(), action);
    expect(replayed.waiting_timeout_at).toEqual(new Date(FIXED_TS.getTime() + 60_000));
  });

  it('_init derives started_at from the action timestamp, not wall clock', () => {
    const action = makeAction('_init' as Action['type'], { start_node: 'a' });
    const next = internalReducer(makeState(), action);
    expect(next.started_at).toEqual(FIXED_TS);
    expect(next.updated_at).toEqual(FIXED_TS);
  });

  it('public reducers stamp updated_at from the action timestamp', () => {
    const updated = updateMemoryReducer(
      makeState(),
      makeAction('update_memory', { updates: { k: 'v' } }),
    );
    expect(updated.updated_at).toEqual(FIXED_TS);

    const handed = handoffReducer(
      makeState(),
      makeAction('handoff', { node_id: 'b', supervisor_id: 's', reasoning: 'r' }),
    );
    expect(handed.updated_at).toEqual(FIXED_TS);
    expect(handed.supervisor_history[0].timestamp).toEqual(FIXED_TS);
  });

  it('replaying the same action sequence twice yields identical timestamps', () => {
    const actions: Action[] = [
      makeAction('_init' as Action['type'], { start_node: 'a' }, new Date('2026-03-15T12:00:00Z')),
      makeAction('update_memory', { updates: { x: 1 } }, new Date('2026-03-15T12:00:05Z')),
      makeAction('_advance' as Action['type'], { node_id: 'b' }, new Date('2026-03-15T12:00:06Z')),
    ];

    const replay = () =>
      actions.reduce(
        (s, a) => (a.type.startsWith('_') ? internalReducer(s, a) : rootReducer(s, a)),
        makeState(),
      );

    const first = replay();
    const second = replay();
    expect(second.started_at).toEqual(first.started_at);
    expect(second.updated_at).toEqual(first.updated_at);
    expect(second.updated_at).toEqual(new Date('2026-03-15T12:00:06Z'));
  });
});
