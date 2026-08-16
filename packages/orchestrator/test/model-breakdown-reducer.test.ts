import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { internalReducer } from '../src/state/reducers.js';
import type { WorkflowState, Action } from '../src/state/state.js';

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
    node_breakdown: {},
    _cost_alert_thresholds_fired: [],
    supervisor_history: [],
    memory_drops: [],
  } as WorkflowState;
}

function trackModel(model: string, input: number, output: number, cost: number, nodeId?: string): Action {
  return {
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: '_track_model_usage',
    payload: {
      model,
      input_tokens: input,
      output_tokens: output,
      cost_usd: cost,
      ...(nodeId ? { node_id: nodeId } : {}),
    },
    metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
  } as Action;
}

describe('_track_model_usage reducer', () => {
  it('creates a new model entry with a call count of 1', () => {
    const next = internalReducer(baseState(), trackModel('claude-opus-4-8', 100, 50, 0.0015));
    expect(next.model_breakdown['claude-opus-4-8']).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.0015,
      calls: 1,
    });
  });

  it('accumulates repeated calls to the same model', () => {
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

  it('tracks multiple models independently', () => {
    let state = baseState();
    state = internalReducer(state, trackModel('claude-haiku-4-5-20251001', 10, 5, 0.00005));
    state = internalReducer(state, trackModel('gpt-4o', 20, 10, 0.0002));
    expect(Object.keys(state.model_breakdown).sort()).toEqual(['claude-haiku-4-5-20251001', 'gpt-4o']);
    expect(state.model_breakdown['claude-haiku-4-5-20251001'].calls).toBe(1);
    expect(state.model_breakdown['gpt-4o'].calls).toBe(1);
  });

  it('tracks token usage even when estimated cost is zero (unknown/local model)', () => {
    const next = internalReducer(baseState(), trackModel('llama3.1', 500, 200, 0));
    expect(next.model_breakdown['llama3.1']).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0,
      calls: 1,
    });
  });
});

describe('_track_model_usage node attribution', () => {
  it('attributes spend to the node that incurred it', () => {
    const next = internalReducer(baseState(), trackModel('claude-opus-4-8', 100, 50, 0.0015, 'research'));

    expect(next.node_breakdown['research'])
      .toEqual({ input_tokens: 100, output_tokens: 50, cost_usd: 0.0015, calls: 1 });
  });

  it('accumulates repeat calls on one node', () => {
    let state = internalReducer(baseState(), trackModel('m', 10, 5, 0.001, 'draft'));
    state = internalReducer(state, trackModel('m', 20, 10, 0.002, 'draft'));

    expect(state.node_breakdown['draft'])
      .toEqual({ input_tokens: 30, output_tokens: 15, cost_usd: 0.003, calls: 2 });
  });

  it('keeps nodes separate while the model total combines them', () => {
    let state = internalReducer(baseState(), trackModel('m', 10, 5, 0.001, 'research'));
    state = internalReducer(state, trackModel('m', 20, 10, 0.002, 'draft'));

    expect({
      research: state.node_breakdown['research'].cost_usd,
      draft: state.node_breakdown['draft'].cost_usd,
      model: state.model_breakdown['m'].cost_usd,
    }).toEqual({ research: 0.001, draft: 0.002, model: 0.003 });
  });

  it('leaves the breakdown empty when the action names no node', () => {
    const next = internalReducer(baseState(), trackModel('m', 10, 5, 0.001));

    expect(next.node_breakdown).toEqual({});
  });
});
