import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// Schema / Type tests
import {
  NodeTypeSchema,
  GraphNodeSchema,
  SupervisorConfigSchema,
} from '../src/types/graph.js';
import { WorkflowStateSchema } from '../src/types/state.js';
import type { Graph, WorkflowState, Action } from '../src/index.js';

// Reducer tests
import { handoffReducer, rootReducer } from '../src/reducers/index.js';

// Validation tests
import { validateGraph } from '../src/validation/graph-validator.js';

// Executor tests (will mock LLM)
import { SUPERVISOR_DONE } from '../src/agent/supervisor-executor/constants.js';

// ─── Helpers ────────────────────────────────────────────────────────────

const createInitialState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test workflow with supervisor',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  supervisor_history: [],
  max_execution_time_ms: 3600000,
});

const createHandoffAction = (
  supervisorId: string,
  targetNodeId: string,
  reasoning: string,
): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type: 'handoff',
  payload: {
    node_id: targetNodeId,
    supervisor_id: supervisorId,
    reasoning,
  },
  metadata: {
    node_id: supervisorId,
    timestamp: new Date(),
    attempt: 1,
  },
});

const createSupervisorGraph = (): Graph => ({
  id: uuidv4(),
  name: 'Supervisor Test Graph',
  description: 'Graph with a supervisor routing between workers',
  nodes: [
    {
      id: 'supervisor',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'supervisor-agent',
        managed_nodes: ['research', 'writer'],
        max_iterations: 10,
      },
      read_keys: ['*'],
      write_keys: ['control_flow', 'status'],
      failure_policy: {
        max_retries: 1,
        backoff_strategy: 'fixed',
        initial_backoff_ms: 100,
        max_backoff_ms: 1000,
      },
      requires_compensation: false,
    },
    {
      id: 'research',
      type: 'agent',
      agent_id: 'research-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 100,
        max_backoff_ms: 1000,
      },
      requires_compensation: false,
    },
    {
      id: 'writer',
      type: 'agent',
      agent_id: 'writer-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 100,
        max_backoff_ms: 1000,
      },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'supervisor', target: 'research', condition: { type: 'always' } },
    { id: 'e2', source: 'supervisor', target: 'writer', condition: { type: 'always' } },
    { id: 'e3', source: 'research', target: 'supervisor', condition: { type: 'always' } },
    { id: 'e4', source: 'writer', target: 'supervisor', condition: { type: 'always' } },
  ],
  start_node: 'supervisor',
  end_nodes: [],
});

// ─── Schema Tests ───────────────────────────────────────────────────────

describe('Supervisor Schema Tests', () => {
  describe('NodeTypeSchema', () => {
    it('accept "supervisor" as a valid node type', () => {
      expect(() => NodeTypeSchema.parse('supervisor')).not.toThrow();
    });

    it('still accept existing node types', () => {
      const types = ['agent', 'tool', 'subgraph', 'synthesizer', 'router'];
      for (const type of types) {
        expect(() => NodeTypeSchema.parse(type)).not.toThrow();
      }
    });
  });

  describe('SupervisorConfigSchema', () => {
    it('parse valid supervisor config', () => {
      const config = {
        agent_id: 'supervisor-agent',
        managed_nodes: ['research', 'writer'],
        max_iterations: 5,
      };

      const parsed = SupervisorConfigSchema.parse(config);
      expect(parsed.agent_id).toBe('supervisor-agent');
      expect(parsed.managed_nodes).toEqual(['research', 'writer']);
      expect(parsed.max_iterations).toBe(5);
    });

    it('apply default max_iterations', () => {
      const config = {
        agent_id: 'supervisor-agent',
        managed_nodes: ['research'],
      };

      const parsed = SupervisorConfigSchema.parse(config);
      expect(parsed.max_iterations).toBe(10);
    });

    it('accept missing agent_id (optional, falls back to node.agent_id)', () => {
      const parsed = SupervisorConfigSchema.parse({
        managed_nodes: ['research'],
      });
      expect(parsed.agent_id).toBeUndefined();
    });

    it('reject missing managed_nodes', () => {
      expect(() => SupervisorConfigSchema.parse({
        agent_id: 'test',
      })).toThrow();
    });
  });

  describe('GraphNodeSchema with supervisor', () => {
    it('parse a supervisor node', () => {
      const node = {
        id: 'supervisor-1',
        type: 'supervisor',
        supervisor_config: {
          agent_id: 'supervisor-agent',
          managed_nodes: ['research', 'writer'],
        },
      };

      const parsed = GraphNodeSchema.parse(node);
      expect(parsed.type).toBe('supervisor');
      expect(parsed.supervisor_config).toBeDefined();
      expect(parsed.supervisor_config?.managed_nodes).toEqual(['research', 'writer']);
    });

    it('allow supervisor without supervisor_config (schema level)', () => {
      const node = {
        id: 'supervisor-1',
        type: 'supervisor',
      };

      expect(() => GraphNodeSchema.parse(node)).not.toThrow();
    });
  });

  describe('WorkflowStateSchema with supervisor_history', () => {
    it('default supervisor_history to empty array', () => {
      const state = {
        workflow_id: uuidv4(),
        run_id: uuidv4(),
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test',
        status: 'pending',
      };

      const parsed = WorkflowStateSchema.parse(state);
      expect(parsed.supervisor_history).toEqual([]);
    });

    it('parse state with supervisor_history', () => {
      const state = {
        workflow_id: uuidv4(),
        run_id: uuidv4(),
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test',
        status: 'running',
        supervisor_history: [
          {
            supervisor_id: 'sup-1',
            delegated_to: 'research',
            reasoning: 'Need data first',
            iteration: 0,
            timestamp: new Date(),
          },
        ],
      };

      const parsed = WorkflowStateSchema.parse(state);
      expect(parsed.supervisor_history).toHaveLength(1);
      expect(parsed.supervisor_history[0].delegated_to).toBe('research');
    });
  });
});

// ─── Reducer Tests ──────────────────────────────────────────────────────

describe('Handoff Reducer', () => {
  it('handle handoff action', () => {
    const state = createInitialState();
    const action = createHandoffAction('supervisor', 'research', 'Need data');

    const newState = handoffReducer(state, action);

    expect(newState.current_node).toBe('research');
    expect(newState.visited_nodes).toContain('research');
    expect(newState.iteration_count).toBe(0); // handoff no longer increments; runner loop does
    expect(newState.supervisor_history).toHaveLength(1);
    expect(newState.supervisor_history[0].supervisor_id).toBe('supervisor');
    expect(newState.supervisor_history[0].delegated_to).toBe('research');
    expect(newState.supervisor_history[0].reasoning).toBe('Need data');
  });

  it('ignore non-handoff actions', () => {
    const state = createInitialState();
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { key: 'value' } },
      metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
    };

    const newState = handoffReducer(state, action);
    expect(newState).toBe(state); // Same reference = no change
  });

  it('accumulate supervisor_history across multiple handoffs', () => {
    let state = createInitialState();

    state = handoffReducer(state, createHandoffAction('supervisor', 'research', 'First'));
    state = handoffReducer(state, createHandoffAction('supervisor', 'writer', 'Second'));
    state = handoffReducer(state, createHandoffAction('supervisor', 'research', 'Third'));

    expect(state.supervisor_history).toHaveLength(3);
    expect(state.supervisor_history[0].delegated_to).toBe('research');
    expect(state.supervisor_history[1].delegated_to).toBe('writer');
    expect(state.supervisor_history[2].delegated_to).toBe('research');
    expect(state.iteration_count).toBe(0); // handoff no longer increments; runner loop does
  });

  it('rootReducer processes handoff actions', () => {
    const state = createInitialState();
    const action = createHandoffAction('supervisor', 'research', 'Need data');

    const newState = rootReducer(state, action);

    expect(newState.current_node).toBe('research');
    expect(newState.supervisor_history).toHaveLength(1);
  });
});

// ─── Validation Tests ───────────────────────────────────────────────────

describe('Supervisor Graph Validation', () => {
  it('validate a well-formed supervisor graph', () => {
    const graph = createSupervisorGraph();
    const result = validateGraph(graph);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fail if supervisor is missing supervisor_config', () => {
    const graph = createSupervisorGraph();
    const supervisorNode = graph.nodes.find(n => n.id === 'supervisor')!;
    (supervisorNode as any).supervisor_config = undefined;

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing supervisor_config'))).toBe(true);
  });

  it('fail if managed_node does not exist in graph', () => {
    const graph = createSupervisorGraph();
    const supervisorNode = graph.nodes.find(n => n.id === 'supervisor')!;
    supervisorNode.supervisor_config!.managed_nodes = ['research', 'nonexistent'];

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("'nonexistent' not found"))).toBe(true);
  });

  it('warn if supervisor has no edge to a managed node', () => {
    const graph = createSupervisorGraph();
    graph.edges = graph.edges.filter(e => !(e.source === 'supervisor' && e.target === 'writer'));

    const result = validateGraph(graph);

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("no edge to managed node 'writer'"))).toBe(true);
  });

  it('warn if supervisor manages itself', () => {
    const graph = createSupervisorGraph();
    const supervisorNode = graph.nodes.find(n => n.id === 'supervisor')!;
    supervisorNode.supervisor_config!.managed_nodes.push('supervisor');

    const result = validateGraph(graph);

    expect(result.warnings.some(w => w.includes('manages itself'))).toBe(true);
  });
});

// ─── Supervisor Executor Tests ──────────────────────────────────────────

describe('Supervisor Executor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('SUPERVISOR_DONE sentinel value is "__done__"', () => {
    expect(SUPERVISOR_DONE).toBe('__done__');
  });
});
