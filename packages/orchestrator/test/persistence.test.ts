import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryUsageRecorder,
  InMemoryRetentionService,
} from '../src/persistence/in-memory.js';
import type { WorkflowState } from '../src/state/state.js';
import type { Graph } from '../src/graph/graph.js';

function createWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date('2026-01-15T10:00:00Z'),
    updated_at: new Date('2026-01-15T10:05:00Z'),
    goal: 'Analyze user research data',
    constraints: ['max 500 tokens per step'],
    status: 'running',
    current_node: 'research-agent',
    iteration_count: 3,
    retry_count: 0,
    max_retries: 3,
    memory: { findings: ['item1', 'item2'] },
    visited_nodes: ['start', 'research-agent'],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3600000,
    supervisor_history: [],
    total_tokens_used: 1200,
    ...overrides,
  };
}

function createGraph(overrides?: Partial<Graph>): Graph {
  return {
    id: uuidv4(),
    name: 'Test Graph',
    description: 'A test graph',
    nodes: [
      {
        id: 'start',
        type: 'agent',
        agent_id: 'agent-1',
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'start',
    end_nodes: ['start'],
    ...overrides,
  };
}

describe('InMemoryPersistenceProvider', () => {
  let provider: InMemoryPersistenceProvider;

  beforeEach(() => {
    provider = new InMemoryPersistenceProvider();
  });

  describe('Graph Operations', () => {
    it('saves and loads a graph', async () => {
      const graph = createGraph();
      await provider.saveGraph(graph);

      const loaded = await provider.loadGraph(graph.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(graph.id);
      expect(loaded!.name).toBe(graph.name);
    });

    it('returns null for unknown graph ID', async () => {
      const loaded = await provider.loadGraph('nonexistent');
      expect(loaded).toBeNull();
    });

    it('list graphs sorted by updated_at descending', async () => {
      const graph1 = createGraph({ name: 'Graph A' });
      await provider.saveGraph(graph1);

      await new Promise(r => setTimeout(r, 5));

      const graph2 = createGraph({ name: 'Graph B' });
      await provider.saveGraph(graph2);

      const list = await provider.listGraphs();
      expect(list.length).toBe(2);
      expect(list[0].name).toBe('Graph B');
    });

    it('supports limit and offset in listGraphs', async () => {
      for (let i = 0; i < 5; i++) {
        await provider.saveGraph(createGraph({ name: `Graph ${i}` }));
      }

      const page1 = await provider.listGraphs({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await provider.listGraphs({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);
    });

    it('upserts a graph on re-save', async () => {
      const graph = createGraph({ name: 'Original' });
      await provider.saveGraph(graph);
      await provider.saveGraph({ ...graph, name: 'Updated' });

      const list = await provider.listGraphs();
      expect(list.length).toBe(1);

      const loaded = await provider.loadGraph(graph.id);
      expect(loaded!.name).toBe('Updated');
    });

    it('stores a null description when the graph has none', async () => {
      const graph = createGraph({ description: undefined });
      await provider.saveGraph(graph);

      const list = await provider.listGraphs();
      expect(list[0].description).toBeNull();
    });

    it('deletes a graph and reports whether it existed', async () => {
      const graph = createGraph();
      await provider.saveGraph(graph);

      expect(await provider.deleteGraph(graph.id)).toBe(true);
      expect(await provider.loadGraph(graph.id)).toBeNull();
      expect(await provider.deleteGraph(graph.id)).toBe(false);
    });
  });

  describe('Workflow Run Operations', () => {
    it('saves and loads a workflow run', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowRun(state);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run).not.toBeNull();
      expect(run!.id).toBe(state.run_id);
      expect(run!.status).toBe('running');
    });

    it('returns null for unknown run ID', async () => {
      const run = await provider.loadWorkflowRun('nonexistent');
      expect(run).toBeNull();
    });

    it('sets completed_at for terminal statuses', async () => {
      const state = createWorkflowState({ status: 'completed' });
      await provider.saveWorkflowRun(state);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.completed_at).not.toBeNull();
    });

    it('does not set completed_at for non-terminal statuses', async () => {
      const state = createWorkflowState({ status: 'running' });
      await provider.saveWorkflowRun(state);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.completed_at).toBeNull();
    });

    it('preserves the original created_at across re-saves', async () => {
      const created = new Date('2026-02-02T02:02:02Z');
      const state = createWorkflowState({ status: 'running', created_at: created });
      await provider.saveWorkflowRun(state);
      await provider.saveWorkflowRun({ ...state, status: 'completed' });

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.created_at).toEqual(created);
    });

    it('stamps a created_at when the state carries none', async () => {
      const state = createWorkflowState({ status: 'running', created_at: undefined as unknown as Date });
      await provider.saveWorkflowRun(state);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.created_at).toBeInstanceOf(Date);
    });

    it('clears completed_at when a run moves back to a non-terminal status', async () => {
      const state = createWorkflowState({ status: 'completed' });
      await provider.saveWorkflowRun(state);

      const affected = await provider.updateRunStatus(state.run_id, 'running');
      expect(affected).toBe(1);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.status).toBe('running');
      expect(run!.completed_at).toBeNull();
    });

    it('lists runs sorted by created_at descending', async () => {
      const state1 = createWorkflowState();
      const state2 = createWorkflowState();
      await provider.saveWorkflowRun(state1);
      await provider.saveWorkflowRun(state2);

      const runs = await provider.listWorkflowRuns();
      expect(runs.length).toBe(2);
    });

    it('updates run status', async () => {
      const state = createWorkflowState({ status: 'running' });
      await provider.saveWorkflowRun(state);

      const affected = await provider.updateRunStatus(state.run_id, 'completed');
      expect(affected).toBe(1);

      const run = await provider.loadWorkflowRun(state.run_id);
      expect(run!.status).toBe('completed');
      expect(run!.completed_at).not.toBeNull();
    });

    it('returns 0 when updating nonexistent run', async () => {
      const affected = await provider.updateRunStatus('nonexistent', 'completed');
      expect(affected).toBe(0);
    });
  });

  describe('Workflow State Operations', () => {
    it('saves and loads the latest workflow state', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState(state);

      const loaded = await provider.loadLatestWorkflowState(state.run_id);
      expect(loaded).not.toBeNull();
      expect(loaded!.run_id).toBe(state.run_id);
      expect(loaded!.status).toBe(state.status);
    });

    it('returns null for unknown run ID', async () => {
      const loaded = await provider.loadLatestWorkflowState('nonexistent');
      expect(loaded).toBeNull();
    });

    it('auto-increments versions', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState(state);
      await provider.saveWorkflowState({ ...state, status: 'completed' });

      const history = await provider.loadWorkflowStateHistory(state.run_id);
      expect(history.length).toBe(2);
      expect(history[0].version).toBe(1);
      expect(history[1].version).toBe(2);
    });

    it('returns empty history for an unknown run', async () => {
      const history = await provider.loadWorkflowStateHistory('nonexistent');
      expect(history).toEqual([]);
    });

    it('maps absent current_node and total_tokens_used to null in history', async () => {
      const state = createWorkflowState({ current_node: undefined, total_tokens_used: undefined as unknown as number });
      await provider.saveWorkflowState(state);

      const history = await provider.loadWorkflowStateHistory(state.run_id);
      expect(history[0].current_node).toBeNull();
      expect(history[0].total_tokens_used).toBeNull();
    });

    it('returns null when loading a version for an unknown run', async () => {
      const loaded = await provider.loadWorkflowStateAtVersion('nonexistent', 1);
      expect(loaded).toBeNull();
    });

    it('loads latest version when multiple exist', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState({ ...state, status: 'running' });
      await provider.saveWorkflowState({ ...state, status: 'completed' });

      const latest = await provider.loadLatestWorkflowState(state.run_id);
      expect(latest!.status).toBe('completed');
    });

    it('loads state at a specific version', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState({ ...state, status: 'pending' });
      await provider.saveWorkflowState({ ...state, status: 'running' });
      await provider.saveWorkflowState({ ...state, status: 'completed' });

      const v1 = await provider.loadWorkflowStateAtVersion(state.run_id, 1);
      expect(v1).not.toBeNull();
      expect(v1!.status).toBe('pending');

      const v2 = await provider.loadWorkflowStateAtVersion(state.run_id, 2);
      expect(v2!.status).toBe('running');

      const v3 = await provider.loadWorkflowStateAtVersion(state.run_id, 3);
      expect(v3!.status).toBe('completed');
    });

    it('returns null for nonexistent version', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState(state);

      const loaded = await provider.loadWorkflowStateAtVersion(state.run_id, 999);
      expect(loaded).toBeNull();
    });

    it('supports limit and offset in state history', async () => {
      const state = createWorkflowState();
      for (let i = 0; i < 5; i++) {
        await provider.saveWorkflowState({ ...state, iteration_count: i });
      }

      const page = await provider.loadWorkflowStateHistory(state.run_id, { limit: 2, offset: 1 });
      expect(page.length).toBe(2);
      expect(page[0].version).toBe(2);
      expect(page[1].version).toBe(3);
    });

    it('deep-copies state on save (no reference sharing)', async () => {
      const state = createWorkflowState();
      await provider.saveWorkflowState(state);

      state.memory.mutated = true;

      const loaded = await provider.loadLatestWorkflowState(state.run_id);
      expect(loaded!.memory).not.toHaveProperty('mutated');
    });
  });

  describe('Event Operations', () => {
    it('returns empty array for unknown run', async () => {
      const events = await provider.loadEvents('nonexistent');
      expect(events).toEqual([]);
    });
  });

  describe('clear', () => {
    it('clears all stored data', async () => {
      const graph = createGraph();
      const state = createWorkflowState();

      await provider.saveGraph(graph);
      await provider.saveWorkflowRun(state);
      await provider.saveWorkflowState(state);

      provider.clear();

      expect(await provider.loadGraph(graph.id)).toBeNull();
      expect(await provider.loadWorkflowRun(state.run_id)).toBeNull();
      expect(await provider.loadLatestWorkflowState(state.run_id)).toBeNull();
    });
  });
});

describe('InMemoryAgentRegistry', () => {
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    registry = new InMemoryAgentRegistry();
  });

  it('returns null for unregistered agent', async () => {
    const agent = await registry.loadAgent('nonexistent');
    expect(agent).toBeNull();
  });

  it('register and load an agent', async () => {
    registry.register({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      model: 'gpt-4',
      provider: 'openai',
      system_prompt: 'You are a test agent.',
      temperature: 0.7,
      max_steps: 10,
      tools: ['web_search'],
      permissions: { read_keys: ['*'], write_keys: ['*'] },
    });

    const agent = await registry.loadAgent('test-agent');
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('Test Agent');
    expect(agent!.model).toBe('gpt-4');
    expect(agent!.tools).toEqual([{ type: 'custom', name: 'web_search' }]);
  });

  it('clears all registered agents', async () => {
    registry.register({
      id: 'agent-1',
      name: 'Agent 1',
      description: null,
      model: 'gpt-4',
      provider: null,
      system_prompt: 'test',
      temperature: 0.7,
      max_steps: 10,
      tools: [],
      permissions: null,
    });

    registry.clear();

    const agent = await registry.loadAgent('agent-1');
    expect(agent).toBeNull();
  });
});

describe('InMemoryPersistenceProvider — saveWorkflowSnapshot', () => {
  let provider: InMemoryPersistenceProvider;

  beforeEach(() => {
    provider = new InMemoryPersistenceProvider();
  });

  it('atomically save both run and state', async () => {
    const state = createWorkflowState();
    await provider.saveWorkflowSnapshot(state);

    const run = await provider.loadWorkflowRun(state.run_id);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(state.run_id);
    expect(run!.status).toBe(state.status);

    const latestState = await provider.loadLatestWorkflowState(state.run_id);
    expect(latestState).not.toBeNull();
    expect(latestState!.run_id).toBe(state.run_id);
  });

  it('create versioned state snapshots', async () => {
    const state = createWorkflowState();
    await provider.saveWorkflowSnapshot(state);
    await provider.saveWorkflowSnapshot({ ...state, status: 'completed' });

    const history = await provider.loadWorkflowStateHistory(state.run_id);
    expect(history.length).toBe(2);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
  });
});

describe('InMemoryAgentRegistry — CRUD', () => {
  let registry: InMemoryAgentRegistry;

  const makeAgentInput = (overrides?: Record<string, unknown>) => ({
    name: 'Test Agent',
    description: 'A test agent' as string | null,
    model: 'gpt-4',
    provider: 'openai',
    system_prompt: 'You are a test agent.',
    temperature: 0.7,
    max_steps: 10,
    tools: [] as never[],
    permissions: { read_keys: ['*'], write_keys: ['*'] },
    ...overrides,
  });

  beforeEach(() => {
    registry = new InMemoryAgentRegistry();
  });

  it('updates an agent', async () => {
    const id = registry.register(makeAgentInput({ name: 'Original' }));
    await registry.updateAgent(id, { name: 'Updated' });

    const agent = await registry.loadAgent(id);
    expect(agent!.name).toBe('Updated');
    expect(agent!.model).toBe('gpt-4');
  });

  it('throws when updating nonexistent agent', async () => {
    await expect(registry.updateAgent('nonexistent', { name: 'X' })).rejects.toThrow('Agent not found');
  });

  it('list agents with pagination', async () => {
    registry.register(makeAgentInput({ name: 'Agent A' }));
    registry.register(makeAgentInput({ name: 'Agent B' }));
    registry.register(makeAgentInput({ name: 'Agent C' }));

    const all = await registry.listAgents();
    expect(all.length).toBe(3);

    const page = await registry.listAgents({ limit: 2, offset: 1 });
    expect(page.length).toBe(2);
  });

  it('deletes an agent', async () => {
    const id = registry.register(makeAgentInput());

    const deleted = await registry.deleteAgent(id);
    expect(deleted).toBe(true);

    const agent = await registry.loadAgent(id);
    expect(agent).toBeNull();
  });

  it('returns false when deleting nonexistent agent', async () => {
    const deleted = await registry.deleteAgent('nonexistent');
    expect(deleted).toBe(false);
  });

  it('round-trips provider_options', async () => {
    const id = registry.register(makeAgentInput({
      provider_options: {
        openai: { response_format: 'json_object' as const },
      },
    }));

    const agent = await registry.loadAgent(id);
    expect(agent!.provider_options).toEqual({
      openai: { response_format: 'json_object' },
    });
  });

  it('preserves provider_options through update', async () => {
    const id = registry.register(makeAgentInput({
      provider_options: { anthropic: { max_tokens: 4096 } },
    }));

    await registry.updateAgent(id, { name: 'Updated' });

    const agent = await registry.loadAgent(id);
    expect(agent!.name).toBe('Updated');
    expect(agent!.provider_options).toEqual({ anthropic: { max_tokens: 4096 } });
  });
});

describe('InMemoryUsageRecorder', () => {
  let recorder: InMemoryUsageRecorder;

  beforeEach(() => {
    recorder = new InMemoryUsageRecorder();
  });

  it('record usage', async () => {
    await recorder.saveUsageRecord({
      run_id: uuidv4(),
      graph_id: uuidv4(),
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.003,
      duration_ms: 1200,
    });

    expect(recorder.records.length).toBe(1);
    expect(recorder.records[0].input_tokens).toBe(100);
  });

  it('stores independent copies', async () => {
    const record = {
      run_id: uuidv4(),
      graph_id: uuidv4(),
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.003,
      duration_ms: 1200,
    };

    await recorder.saveUsageRecord(record);

    record.input_tokens = 9999;
    expect(recorder.records[0].input_tokens).toBe(100);
  });

  it('clears all records', async () => {
    await recorder.saveUsageRecord({
      run_id: uuidv4(),
      graph_id: uuidv4(),
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.003,
      duration_ms: 1200,
    });

    recorder.clear();
    expect(recorder.records.length).toBe(0);
  });
});

describe('InMemoryRetentionService', () => {
  let retention: InMemoryRetentionService;

  beforeEach(() => {
    retention = new InMemoryRetentionService();
  });

  it('returns 0 for archiveCompletedWorkflows (no-op)', async () => {
    const count = await retention.archiveCompletedWorkflows();
    expect(count).toBe(0);
  });

  it('returns 0 for deleteWarmData (no-op)', async () => {
    const count = await retention.deleteWarmData();
    expect(count).toBe(0);
  });

  it('returns zero stats for getStorageStats', async () => {
    const stats = await retention.getStorageStats();
    expect(stats).toEqual({ hot_runs: 0, warm_runs: 0, cold_runs: 0 });
  });
});
