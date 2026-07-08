import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { internalReducer } from '../src/reducers/index.js';
import type { WorkflowState, Action } from '../src/types/state.js';

/** Minimal running state for exercising the per-model usage reducer. */
function baseState(): WorkflowState {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'test',
    constraints: [],
    status: 'running',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3_600_000,
    total_tokens_used: 0,
    total_cost_usd: 0,
    model_breakdown: {},
    _cost_alert_thresholds_fired: [],
    supervisor_history: [],
    memory_drops: [],
  } as WorkflowState;
}

function trackModel(model: string, input: number, output: number, cost: number): Action {
  return {
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: '_track_model_usage',
    payload: { model, input_tokens: input, output_tokens: output, cost_usd: cost },
    metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
  } as Action;
}

describe('_track_model_usage reducer', () => {
  test('creates a new model entry with a call count of 1', () => {
    const next = internalReducer(baseState(), trackModel('claude-opus-4-8', 100, 50, 0.0015));
    expect(next.model_breakdown['claude-opus-4-8']).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.0015,
      calls: 1,
    });
  });

  test('accumulates repeated calls to the same model', () => {
    let state = baseState();
    state = internalReducer(state, trackModel('gpt-4o', 100, 40, 0.001));
    state = internalReducer(state, trackModel('gpt-4o', 200, 60, 0.002));
    expect(state.model_breakdown['gpt-4o']).toEqual({
      input_tokens: 300,
      output_tokens: 100,
      cost_usd: 0.003,
      calls: 2,
    });
  });

  test('tracks multiple models independently', () => {
    let state = baseState();
    state = internalReducer(state, trackModel('claude-haiku-4-5-20251001', 10, 5, 0.00005));
    state = internalReducer(state, trackModel('gpt-4o', 20, 10, 0.0002));
    expect(Object.keys(state.model_breakdown).sort()).toEqual(['claude-haiku-4-5-20251001', 'gpt-4o']);
    expect(state.model_breakdown['claude-haiku-4-5-20251001'].calls).toBe(1);
    expect(state.model_breakdown['gpt-4o'].calls).toBe(1);
  });

  test('tracks token usage even when estimated cost is zero (unknown/local model)', () => {
    const next = internalReducer(baseState(), trackModel('llama3.1', 500, 200, 0));
    expect(next.model_breakdown['llama3.1']).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0,
      calls: 1,
    });
  });
});
