import { describe, it, expect } from 'vitest';
import {
  WorkflowStateSchema,
  WorkflowStatusSchema,
  WaitingReasonSchema,
  ActionSchema,
  ActionTypeSchema,
  UpdateMemoryPayloadSchema,
  SetStatusPayloadSchema,
  GotoNodePayloadSchema,
  HandoffPayloadSchema,
  RequestHumanInputPayloadSchema,
  ResumeFromHumanPayloadSchema,
  MergeParallelResultsPayloadSchema,
  InternalActionTypeSchema,
  narrowActionPayload,
} from '../src/types/state.js';
import {
  GraphSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  FailurePolicySchema,
  NodeTypeSchema,
  EvolutionConfigSchema,
  VotingConfigSchema,
  MapReduceConfigSchema,
  SupervisorConfigSchema,
} from '../src/types/graph.js';

describe('Type Validation (Zod Schemas)', () => {
  describe('WorkflowStatusSchema', () => {
    it('accepts valid statuses', () => {
      const validStatuses = [
        'pending',
        'scheduled',
        'running',
        'waiting',
        'retrying',
        'completed',
        'failed',
        'cancelled',
        'timeout',
      ];

      for (const status of validStatuses) {
        expect(() => WorkflowStatusSchema.parse(status)).not.toThrow();
      }
    });

    it('rejects invalid statuses', () => {
      expect(() => WorkflowStatusSchema.parse('invalid')).toThrow();
      expect(() => WorkflowStatusSchema.parse('RUNNING')).toThrow();
      expect(() => WorkflowStatusSchema.parse('')).toThrow();
    });
  });

  describe('WaitingReasonSchema', () => {
    it('accepts valid waiting reasons', () => {
      const validReasons = [
        'human_approval',
        'external_event',
        'scheduled_time',
        'rate_limit',
        'resource_limit',
      ];

      for (const reason of validReasons) {
        expect(() => WaitingReasonSchema.parse(reason)).not.toThrow();
      }
    });

    it('rejects invalid reasons', () => {
      expect(() => WaitingReasonSchema.parse('unknown')).toThrow();
    });
  });

  describe('WorkflowStateSchema', () => {
    it('parses valid workflow state', () => {
      const validState = {
        workflow_id: '123e4567-e89b-12d3-a456-426614174000',
        run_id: '123e4567-e89b-12d3-a456-426614174001',
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test goal',
        constraints: ['constraint1'],
        status: 'running',
        iteration_count: 5,
        retry_count: 0,
        max_retries: 3,
        memory: { test: 'value' },
        visited_nodes: ['node1', 'node2'],
        max_iterations: 50,
        compensation_stack: [],
        max_execution_time_ms: 3600000,
      };

      expect(() => WorkflowStateSchema.parse(validState)).not.toThrow();
    });

    it('applies default values', () => {
      const minimalState = {
        workflow_id: '123e4567-e89b-12d3-a456-426614174000',
        run_id: '123e4567-e89b-12d3-a456-426614174001',
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test',
        status: 'pending',
      };

      const parsed = WorkflowStateSchema.parse(minimalState);

      expect(parsed.iteration_count).toBe(0);
      expect(parsed.retry_count).toBe(0);
      expect(parsed.max_retries).toBe(3);
      expect(parsed.memory).toEqual({});
      expect(parsed.visited_nodes).toEqual([]);
      expect(parsed.max_iterations).toBe(50);
      expect(parsed.compensation_stack).toEqual([]);
      expect(parsed.max_execution_time_ms).toBe(3600000);
    });

    it('rejects missing required fields', () => {
      expect(() => WorkflowStateSchema.parse({})).toThrow();
      expect(() =>
        WorkflowStateSchema.parse({
          workflow_id: '123e4567-e89b-12d3-a456-426614174000',
        })
      ).toThrow();
    });
  });

  describe('ActionSchema', () => {
    it('parses valid action', () => {
      const validAction = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'update_memory',
        payload: { updates: { key: 'value' } },
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      expect(() => ActionSchema.parse(validAction)).not.toThrow();
    });

    it('parses action with compensation', () => {
      const actionWithCompensation = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'update_memory',
        payload: { amount: 100 },
        compensation: {
          type: 'update_memory',
          payload: { amount: -100 },
        },
        metadata: {
          node_id: 'payment',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      expect(() => ActionSchema.parse(actionWithCompensation)).not.toThrow();
    });

    it('applies default attempt value', () => {
      const action = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'set_status',
        payload: {},
        metadata: {
          node_id: 'test',
          timestamp: new Date(),
        },
      };

      const parsed = ActionSchema.parse(action);
      expect(parsed.metadata.attempt).toBe(1);
    });
  });

  describe('ActionTypeSchema', () => {
    const validActionTypes = [
      'update_memory',
      'set_status',
      'goto_node',
      'handoff',
      'request_human_input',
      'resume_from_human',
      'merge_parallel_results',
    ] as const;

    it('accepts all 7 valid action types', () => {
      for (const type of validActionTypes) {
        expect(() => ActionTypeSchema.parse(type)).not.toThrow();
      }
    });

    it('rejects invalid action type', () => {
      const result = ActionTypeSchema.safeParse('invalid_type');
      expect(result.success).toBe(false);
    });

    it('rejects typo action type (updat_memory)', () => {
      const result = ActionTypeSchema.safeParse('updat_memory');
      expect(result.success).toBe(false);
    });

    it('ActionSchema should parse with valid type update_memory', () => {
      const action = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'update_memory',
        payload: { updates: { key: 'value' } },
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      expect(() => ActionSchema.parse(action)).not.toThrow();
    });

    it('ActionSchema should reject invalid type string', () => {
      const action = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'invalid_type',
        payload: {},
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      const result = ActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });

    it('ActionSchema should reject typo type (updat_memory)', () => {
      const action = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'updat_memory',
        payload: {},
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      const result = ActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });

    it('all 7 valid types should parse successfully through ActionSchema', () => {
      for (const type of validActionTypes) {
        const action = {
          id: '123e4567-e89b-12d3-a456-426614174000',
          idempotency_key: `key-${type}`,
          type,
          payload: {},
          metadata: {
            node_id: 'test-node',
            timestamp: new Date(),
            attempt: 1,
          },
        };

        const result = ActionSchema.safeParse(action);
        expect(result.success, `Expected type '${type}' to parse successfully`).toBe(true);
      }
    });
  });

  describe('Action Payload Schemas', () => {
    it('UpdateMemoryPayloadSchema validates correct payload', () => {
      const result = UpdateMemoryPayloadSchema.safeParse({ updates: { key: 'value' } });
      expect(result.success).toBe(true);
    });

    it('UpdateMemoryPayloadSchema rejects missing updates', () => {
      const result = UpdateMemoryPayloadSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('SetStatusPayloadSchema validates correct payload', () => {
      const result = SetStatusPayloadSchema.safeParse({ status: 'running' });
      expect(result.success).toBe(true);
    });

    it('SetStatusPayloadSchema rejects invalid status', () => {
      const result = SetStatusPayloadSchema.safeParse({ status: 'invalid_status' });
      expect(result.success).toBe(false);
    });

    it('GotoNodePayloadSchema validates correct payload', () => {
      const result = GotoNodePayloadSchema.safeParse({ node_id: 'node-1' });
      expect(result.success).toBe(true);
    });

    it('GotoNodePayloadSchema rejects missing node_id', () => {
      const result = GotoNodePayloadSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('HandoffPayloadSchema validates correct payload', () => {
      const result = HandoffPayloadSchema.safeParse({
        node_id: 'worker',
        supervisor_id: 'sup-1',
        reasoning: 'Best match for this task',
      });
      expect(result.success).toBe(true);
    });

    it('HandoffPayloadSchema rejects missing required fields', () => {
      expect(HandoffPayloadSchema.safeParse({ node_id: 'worker' }).success).toBe(false);
      expect(HandoffPayloadSchema.safeParse({ node_id: 'worker', supervisor_id: 'sup' }).success).toBe(false);
    });

    it('RequestHumanInputPayloadSchema validates with optional fields', () => {
      const result = RequestHumanInputPayloadSchema.safeParse({
        pending_approval: { question: 'approve?' },
      });
      expect(result.success).toBe(true);
    });

    it('ResumeFromHumanPayloadSchema validates correct payload', () => {
      const result = ResumeFromHumanPayloadSchema.safeParse({
        response: 'approved',
        decision: 'yes',
        memory_updates: { extra: 'data' },
      });
      expect(result.success).toBe(true);
    });

    it('MergeParallelResultsPayloadSchema validates with optional tokens', () => {
      const result = MergeParallelResultsPayloadSchema.safeParse({
        updates: { result_a: 'done', result_b: 'done' },
        total_tokens: 150,
      });
      expect(result.success).toBe(true);
    });

    it('MergeParallelResultsPayloadSchema validates without optional tokens', () => {
      const result = MergeParallelResultsPayloadSchema.safeParse({
        updates: { result_a: 'done' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('InternalActionTypeSchema', () => {
    const internalTypes = [
      '_init', '_fail', '_complete', '_advance', '_timeout', '_cancel',
      '_track_tokens', '_track_cost', '_fire_cost_threshold',
      '_budget_exceeded', '_push_compensation', '_increment_iteration',
      '_pop_compensation',
    ];

    it('accepts all 13 internal action types', () => {
      for (const type of internalTypes) {
        expect(InternalActionTypeSchema.safeParse(type).success).toBe(true);
      }
    });

    it('rejects non-internal types', () => {
      expect(InternalActionTypeSchema.safeParse('update_memory').success).toBe(false);
      expect(InternalActionTypeSchema.safeParse('_unknown').success).toBe(false);
    });
  });

  describe('narrowActionPayload', () => {
    it('narrows update_memory payload', () => {
      const result = narrowActionPayload('update_memory', { updates: { key: 'val' } });
      expect(result).toHaveProperty('updates');
    });

    it('throws on invalid payload', () => {
      expect(() => narrowActionPayload('update_memory', {})).toThrow();
    });
  });

  describe('NodeTypeSchema', () => {
    it('accepts valid node types', () => {
      const validTypes = ['agent', 'tool', 'subgraph', 'synthesizer', 'router'];

      for (const type of validTypes) {
        expect(() => NodeTypeSchema.parse(type)).not.toThrow();
      }
    });

    it('rejects invalid node types', () => {
      expect(() => NodeTypeSchema.parse('invalid')).toThrow();
    });
  });

  describe('FailurePolicySchema', () => {
    it('parses valid failure policy', () => {
      const validPolicy = {
        max_retries: 5,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 1000,
        max_backoff_ms: 60000,
        circuit_breaker: {
          enabled: true,
          failure_threshold: 5,
          success_threshold: 2,
          timeout_ms: 60000,
        },
        timeout_ms: 30000,
      };

      expect(() => FailurePolicySchema.parse(validPolicy)).not.toThrow();
    });

    it('applies default values', () => {
      const parsed = FailurePolicySchema.parse({});

      expect(parsed.max_retries).toBe(3);
      expect(parsed.backoff_strategy).toBe('exponential');
      expect(parsed.initial_backoff_ms).toBe(1000);
      expect(parsed.max_backoff_ms).toBe(60000);
    });

    it('rejects an unbounded max_retries (cost-exhaustion guard)', () => {
      expect(() => FailurePolicySchema.parse({ max_retries: 1_000_000_000 })).toThrow();
      expect(() => FailurePolicySchema.parse({ max_retries: Infinity })).toThrow();
      expect(() => FailurePolicySchema.parse({ max_retries: NaN })).toThrow();
      expect(() => FailurePolicySchema.parse({ max_retries: -1 })).toThrow();
      expect(FailurePolicySchema.parse({ max_retries: 0 }).max_retries).toBe(0);
      expect(FailurePolicySchema.parse({ max_retries: 10 }).max_retries).toBe(10);
    });

    it('validates backoff strategy enum', () => {
      expect(() =>
        FailurePolicySchema.parse({ backoff_strategy: 'invalid' })
      ).toThrow();

      expect(() =>
        FailurePolicySchema.parse({ backoff_strategy: 'linear' })
      ).not.toThrow();
    });
  });

  describe('GraphNodeSchema', () => {
    it('parses valid graph node', () => {
      const validNode = {
        id: 'node-1',
        type: 'agent',
        agent_id: 'planner',
        read_keys: ['input'],
        write_keys: ['plan'],
        failure_policy: {
          max_retries: 3,
        },
        requires_compensation: false,
      };

      expect(() => GraphNodeSchema.parse(validNode)).not.toThrow();
    });

    it('applies default values', () => {
      const minimalNode = {
        id: 'node-1',
        type: 'tool',
      };

      const parsed = GraphNodeSchema.parse(minimalNode);

      expect(parsed.read_keys).toEqual([]);
      expect(parsed.write_keys).toEqual([]);
      expect(parsed.requires_compensation).toBe(false);
      expect(parsed.failure_policy).toBeDefined();
    });
  });

  describe('GraphEdgeSchema', () => {
    it('parses valid edge', () => {
      const validEdge = {
        id: 'e1',
        source: 'node1',
        target: 'node2',
        condition: { type: 'always' },
      };

      expect(() => GraphEdgeSchema.parse(validEdge)).not.toThrow();
    });

    it('applies default condition', () => {
      const edge = {
        id: 'e1',
        source: 'node1',
        target: 'node2',
      };

      const parsed = GraphEdgeSchema.parse(edge);
      expect(parsed.condition.type).toBe('always');
    });
  });

  describe('GraphSchema', () => {
    it('parses valid graph', () => {
      const validGraph = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Test Graph',
        description: 'A test graph',
        nodes: [
          { id: 'start', type: 'agent' },
          { id: 'end', type: 'agent' },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'end' },
        ],
        start_node: 'start',
        end_nodes: ['end'],
      };

      expect(() => GraphSchema.parse(validGraph)).not.toThrow();
    });

    it('auto-generates id when omitted', () => {
      const parsed = GraphSchema.parse({
        name: 'Test',
        description: 'Test',
        nodes: [],
        edges: [],
        start_node: 'start',
        end_nodes: [],
      });

      expect(parsed.id).toBeDefined();
      expect(typeof parsed.id).toBe('string');
      expect(parsed.id.length).toBeGreaterThan(0);
    });

    it('preserves explicitly provided id', () => {
      const parsed = GraphSchema.parse({
        id: 'my-custom-id',
        name: 'Test',
        description: 'Test',
        nodes: [],
        edges: [],
        start_node: 'start',
        end_nodes: [],
      });

      expect(parsed.id).toBe('my-custom-id');
    });
  });
});

describe('Resource bounds (DoS guards)', () => {
  it('evolution population_size and max_generations are capped', () => {
    const base = { candidate_agent_id: 'gen' };
    expect(EvolutionConfigSchema.safeParse({ ...base, population_size: 100 }).success).toBe(true);
    expect(EvolutionConfigSchema.safeParse({ ...base, population_size: 100_000 }).success).toBe(false);
    expect(EvolutionConfigSchema.safeParse({ ...base, max_generations: 100 }).success).toBe(true);
    expect(EvolutionConfigSchema.safeParse({ ...base, max_generations: 100_000 }).success).toBe(false);
  });

  it('evolution max_concurrency is capped at 50', () => {
    const base = { candidate_agent_id: 'gen' };
    expect(EvolutionConfigSchema.safeParse({ ...base, max_concurrency: 50 }).success).toBe(true);
    expect(EvolutionConfigSchema.safeParse({ ...base, max_concurrency: 51 }).success).toBe(false);
  });

  it('voting voter_agent_ids is capped at 50', () => {
    const ok = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const tooMany = Array.from({ length: 51 }, (_, i) => `v${i}`);
    expect(VotingConfigSchema.safeParse({ voter_agent_ids: ok }).success).toBe(true);
    expect(VotingConfigSchema.safeParse({ voter_agent_ids: tooMany }).success).toBe(false);
  });

  it('map-reduce max_concurrency is capped at 50', () => {
    expect(MapReduceConfigSchema.safeParse({ worker_node_id: 'w', max_concurrency: 50 }).success).toBe(true);
    expect(MapReduceConfigSchema.safeParse({ worker_node_id: 'w', max_concurrency: 100_000 }).success).toBe(false);
  });

  it('supervisor max_iterations is capped at 1000', () => {
    const base = { managed_nodes: ['a'] };
    expect(SupervisorConfigSchema.safeParse({ ...base, max_iterations: 1000 }).success).toBe(true);
    expect(SupervisorConfigSchema.safeParse({ ...base, max_iterations: 1_000_001 }).success).toBe(false);
  });

  it('fan-out knobs reject non-integers', () => {
    expect(EvolutionConfigSchema.safeParse({ candidate_agent_id: 'g', population_size: 5.5 }).success).toBe(false);
  });
});
