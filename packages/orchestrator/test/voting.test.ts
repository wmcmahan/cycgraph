/**
 * Tests for executeVotingNode: parallel voter execution plus consensus
 * aggregation across the majority_vote, weighted_vote, and llm_judge
 * strategies, exercised both through GraphRunner (integration) and via
 * direct calls (unit, for branches graph validation would otherwise
 * intercept before the executor's own guards run).
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

let voterResponses: Record<string, string> = {};
vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number) => {
    const voteKey = stateView.memory._vote_key || 'vote';
    const vote = voterResponses[agentId] || 'default_vote';
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { [voteKey]: vote } },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 25 },
      },
    };
  }),
}));

vi.mock('../src/agents/executors/supervisor/supervisor-executor.js', () => ({ executeSupervisor: vi.fn() }));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agents/executors/evaluator/executor.js', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));
vi.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { executeVotingNode } from '../src/execution/nodes/voting.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState, StateView, Action } from '../src/state/state.js';
import type {
  NodeExecutorContext,
  ExecutorDependencies,
  AgentConfigShape,
} from '../src/execution/nodes/context.js';
import type { ModelResolver } from '../src/agents/models/model-resolver.js';

// ─── GraphRunner-integration helpers ────────────────────────────────

const createState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Voting test',
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
  supervisor_history: [],
});

const createVotingGraph = (config: any = {}): Graph => ({
  id: 'voting-graph',
  name: 'Voting Test',
  description: 'Test voting',
  nodes: [{
    id: 'vote-node',
    type: 'voting',
    voting_config: {
      voter_agent_ids: ['voter-a', 'voter-b', 'voter-c'],
      strategy: 'majority_vote',
      vote_key: 'vote',
      ...config,
    },
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
  }],
  edges: [],
  start_node: 'vote-node',
  end_nodes: ['vote-node'],
});

// ─── Direct-call helpers ─────────────────────────────────────────────
// These bypass GraphRunner (and its validateGraph pre-check) entirely,
// calling executeVotingNode's own guards directly — needed for branches
// (missing voting_config, missing judge_agent_id) that validateGraph
// rejects before the executor ever runs in the integration path.

function makeVotingNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'vote-node',
    type: 'voting',
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
    ...overrides,
  } as GraphNode;
}

function makeDirectState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'Direct-call voting test',
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
    ...overrides,
  };
}

function makeDirectStateView(overrides: Partial<StateView> = {}): StateView {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    goal: 'Direct-call voting test',
    constraints: [],
    memory: {},
    ...overrides,
  };
}

function makeAgentConfig(overrides: Partial<AgentConfigShape> = {}): AgentConfigShape {
  return {
    tools: [],
    write_keys: [],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

function makeVoterAction(updates: Record<string, unknown>, overrides: Partial<Action> = {}): Action {
  return {
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates },
    metadata: { node_id: 'voter', timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 25 } },
    ...overrides,
  } as Action;
}

function makeDirectDeps(overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies {
  return {
    executeAgent: vi.fn().mockResolvedValue(makeVoterAction({ vote: 'default' })),
    executeSupervisor: vi.fn(),
    evaluateQualityExecutor: vi.fn(),
    extractFactsExecutor: vi.fn(),
    resolveTools: vi.fn().mockResolvedValue({}),
    loadAgent: vi.fn().mockResolvedValue(makeAgentConfig()),
    ...overrides,
  };
}

function makeDirectCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: makeDirectState(),
    graph: { id: 'g', name: 'g', nodes: [], edges: [], start_node: 'vote-node' } as unknown as Graph,
    createStateView: () => makeDirectStateView(),
    deps: makeDirectDeps(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('executeVotingNode', () => {
  describe('majority_vote strategy', () => {
    it('picks the most common vote', async () => {
      voterResponses = { 'voter-a': 'option_A', 'voter-b': 'option_A', 'voter-c': 'option_B' };

      const graph = createVotingGraph();
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['vote-node_consensus']).toBe('option_A');
      expect((finalState.memory['vote-node_votes'] as any[])).toHaveLength(3);
    });

    it('resolves to a single consensus value when all voters agree', async () => {
      voterResponses = { 'voter-a': 'same', 'voter-b': 'same', 'voter-c': 'same' };

      const graph = createVotingGraph();
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.memory['vote-node_consensus']).toBe('same');
    });

    it('throws when no votes are received', async () => {
      const node = makeVotingNode({
        voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
      });
      const deps = makeDirectDeps({
        executeAgent: vi.fn().mockRejectedValue(new Error('voter unavailable')),
      });
      const ctx = makeDirectCtx({ deps });

      await expect(executeVotingNode(node, makeDirectStateView(), 1, ctx)).rejects.toThrow(
        'no votes received for majority_vote',
      );
    });

    describe('canonical vote comparison', () => {
      it('treats votes as equal when object keys are reordered', async () => {
        const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
        const original = (executeAgent as any).getMockImplementation();
        (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
          const voteKey = stateView.memory._vote_key || 'vote';
          let vote: any;
          if (agentId === 'voter-a') vote = { a: 1, b: 2 };
          else if (agentId === 'voter-b') vote = { x: 99 };
          else vote = { b: 2, a: 1 };
          return {
            id: uuidv4(),
            idempotency_key: uuidv4(),
            type: 'update_memory',
            payload: { updates: { [voteKey]: vote } },
            metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
          };
        });

        try {
          const graph = createVotingGraph();
          const state = createState();

          const runner = new GraphRunner(graph, state);
          const finalState = await runner.run();

          expect(finalState.memory['vote-node_consensus']).toEqual({ a: 1, b: 2 });
        } finally {
          (executeAgent as any).mockImplementation(original);
        }
      });

      it('discriminates plain string votes normally', async () => {
        voterResponses = { 'voter-a': 'yes', 'voter-b': 'no', 'voter-c': 'yes' };

        const graph = createVotingGraph();
        const state = createState();

        const runner = new GraphRunner(graph, state);
        const finalState = await runner.run();

        expect(finalState.memory['vote-node_consensus']).toBe('yes');
      });

      it('compares array votes by content, not reference identity', async () => {
        const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
        const original = (executeAgent as any).getMockImplementation();
        (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
          const voteKey = stateView.memory._vote_key || 'vote';
          const vote = agentId === 'voter-b' ? ['x', 'y'] : ['a', 'b'];
          return {
            id: uuidv4(),
            idempotency_key: uuidv4(),
            type: 'update_memory',
            payload: { updates: { [voteKey]: vote } },
            metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
          };
        });

        try {
          const graph = createVotingGraph();
          const state = createState();

          const runner = new GraphRunner(graph, state);
          const finalState = await runner.run();

          expect(finalState.memory['vote-node_consensus']).toEqual(['a', 'b']);
        } finally {
          (executeAgent as any).mockImplementation(original);
        }
      });
    });
  });

  describe('weighted_vote strategy', () => {
    it('respects configured weights when picking a winner', async () => {
      voterResponses = { 'voter-a': 'A', 'voter-b': 'B', 'voter-c': 'B' };

      const graph = createVotingGraph({
        strategy: 'weighted_vote',
        weights: { 'voter-a': 5, 'voter-b': 1, 'voter-c': 1 },
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.memory['vote-node_consensus']).toBe('A');
    });

    it('treats nested objects with different key ordering as equal', async () => {
      const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
      const original = (executeAgent as any).getMockImplementation();
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const voteKey = stateView.memory._vote_key || 'vote';
        let vote: any;
        if (agentId === 'voter-a') vote = { outer: { z: 3, a: 1 } };
        else if (agentId === 'voter-b') vote = { different: true };
        else vote = { outer: { a: 1, z: 3 } };
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [voteKey]: vote } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
        };
      });

      try {
        const graph = createVotingGraph({
          strategy: 'weighted_vote',
          weights: { 'voter-a': 1, 'voter-b': 1, 'voter-c': 1 },
        });
        const state = createState();

        const runner = new GraphRunner(graph, state);
        const finalState = await runner.run();

        const consensus = finalState.memory['vote-node_consensus'] as any;
        expect(consensus.outer).toEqual({ z: 3, a: 1 });
      } finally {
        (executeAgent as any).mockImplementation(original);
      }
    });

    it('defaults every voter to weight 1 when no weights are configured', async () => {
      const node = makeVotingNode({
        voting_config: {
          voter_agent_ids: ['voter-a', 'voter-b', 'voter-c'],
          strategy: 'weighted_vote',
          vote_key: 'vote',
        },
      });
      const votesByAgent: Record<string, string> = { 'voter-a': 'A', 'voter-b': 'A', 'voter-c': 'B' };
      const deps = makeDirectDeps({
        executeAgent: vi.fn(async (agentId: string) =>
          makeVoterAction({ vote: votesByAgent[agentId] }, {
            metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 10 } },
          }),
        ),
      });
      const ctx = makeDirectCtx({ deps });

      const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

      expect(action.payload.updates['vote-node_consensus']).toBe('A');
    });

    it('defaults an individual voter to weight 1 when absent from the weights map', async () => {
      const node = makeVotingNode({
        voting_config: {
          voter_agent_ids: ['voter-a', 'voter-b', 'voter-c'],
          strategy: 'weighted_vote',
          vote_key: 'vote',
          weights: { 'voter-a': 5 },
        },
      });
      const votesByAgent: Record<string, string> = { 'voter-a': 'A', 'voter-b': 'B', 'voter-c': 'B' };
      const deps = makeDirectDeps({
        executeAgent: vi.fn(async (agentId: string) =>
          makeVoterAction({ vote: votesByAgent[agentId] }, {
            metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 10 } },
          }),
        ),
      });
      const ctx = makeDirectCtx({ deps });

      const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

      expect(action.payload.updates['vote-node_consensus']).toBe('A');
    });

    it('throws when no votes are received', async () => {
      const node = makeVotingNode({
        voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'weighted_vote', vote_key: 'vote' },
      });
      const deps = makeDirectDeps({
        executeAgent: vi.fn().mockRejectedValue(new Error('voter unavailable')),
      });
      const ctx = makeDirectCtx({ deps });

      await expect(executeVotingNode(node, makeDirectStateView(), 1, ctx)).rejects.toThrow(
        'no votes received for weighted_vote',
      );
    });
  });

  describe('llm_judge strategy', () => {
    it('delegates consensus selection to the evaluator agent', async () => {
      voterResponses = { 'voter-a': 'plan_A', 'voter-b': 'plan_B', 'voter-c': 'plan_A' };
      mockEvaluateQuality.mockResolvedValue({
        score: 0.9,
        reasoning: 'plan_A is better because...',
        tokensUsed: 50,
      });

      const graph = createVotingGraph({
        strategy: 'llm_judge',
        judge_agent_id: 'judge',
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(mockEvaluateQuality).toHaveBeenCalledWith(
        'judge',
        'Voting test',
        expect.any(Array),
        expect.any(String),
        expect.anything(),
      );
    });

    it('rejects the graph before execution when judge_agent_id is missing (graph validation)', async () => {
      voterResponses = { 'voter-a': 'A', 'voter-b': 'B', 'voter-c': 'A' };

      const graph = createVotingGraph({ strategy: 'llm_judge' });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await expect(runner.run()).rejects.toThrow('judge_agent_id');
    });

    it('throws when judge_agent_id is missing, bypassing graph validation', async () => {
      const node = makeVotingNode({
        voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'llm_judge', vote_key: 'vote' },
      });
      const deps = makeDirectDeps({
        executeAgent: vi.fn(async (agentId: string) => makeVoterAction({ vote: 'A' }, {
          metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 10 } },
        })),
      });
      const ctx = makeDirectCtx({ deps });

      await expect(executeVotingNode(node, makeDirectStateView(), 1, ctx)).rejects.toThrow('missing judge_agent_id');
    });
  });

  it('throws when fewer voters respond than the quorum requires', async () => {
    const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
    const original = (executeAgent as any).getMockImplementation();
    let callNum = 0;
    (executeAgent as any).mockImplementation(async (...args: any[]) => {
      callNum++;
      if (callNum === 2) throw new Error('Voter unavailable');
      return original!(...args);
    });

    try {
      const graph = createVotingGraph({ quorum: 3 });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await expect(runner.run()).rejects.toThrow('quorum');
    } finally {
      (executeAgent as any).mockImplementation(original);
    }
  });

  it('forwards lesson provenance from every voter into the merged action', async () => {
    voterResponses = { 'voter-a': 'A', 'voter-b': 'A', 'voter-c': 'B' };

    const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
    const original = (executeAgent as any).getMockImplementation();
    (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
      const voteKey = stateView.memory._vote_key || 'vote';
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: {
          updates: {
            [voteKey]: voterResponses[agentId],
            _lesson_provenance: {
              [`entry-${agentId}`]: {
                node_id: `vote-node_voter_${agentId}`,
                agent_id: agentId,
                fact_ids: [`fact-${agentId}`],
                retrieved_at: '2026-06-11T10:00:00.000Z',
              },
            },
          },
        },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 25 },
        },
      };
    });

    try {
      const graph = createVotingGraph();
      const state = createState();
      const finalState = await new GraphRunner(graph, state).run();

      expect(finalState.status).toBe('completed');
      const registry = finalState.lesson_provenance as Record<string, any>;
      expect(Object.keys(registry).sort()).toEqual(['entry-voter-a', 'entry-voter-b', 'entry-voter-c']);
      expect(registry['entry-voter-b'].fact_ids).toEqual(['fact-voter-b']);
      const votes = finalState.memory['vote-node_votes'] as Array<{ vote: unknown }>;
      expect(votes.every((v) => typeof v.vote === 'string')).toBe(true);
    } finally {
      (executeAgent as any).mockImplementation(original);
    }
  });

  describe('token accounting', () => {
    it('sums total tokens across all voters exactly once', async () => {
      voterResponses = { 'voter-a': 'A', 'voter-b': 'A', 'voter-c': 'B' };

      const graph = createVotingGraph();
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.total_tokens_used).toBe(75);
    });

    it('does not count tokens for voters that produced no action', async () => {
      const node = makeVotingNode({
        voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
      });
      const deps = makeDirectDeps({
        executeAgent: vi.fn(async (agentId: string) => {
          if (agentId === 'voter-a') throw new Error('voter unavailable');
          return makeVoterAction({ vote: 'A' }, {
            metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 25 } },
          });
        }),
      });
      const ctx = makeDirectCtx({ deps });

      const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

      expect(action.metadata.token_usage).toEqual({ totalTokens: 25, inputTokens: 0, outputTokens: 0 });
    });

    it('falls back to input+output token sum and records the first reported model', async () => {
      const node = makeVotingNode({
        voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
      });
      const deps = makeDirectDeps({
        executeAgent: vi.fn(async (agentId: string) => {
          if (agentId === 'voter-a') {
            return makeVoterAction({ vote: 'A' }, {
              metadata: {
                node_id: agentId, timestamp: new Date(), attempt: 1,
                model: 'claude-voter-model',
                token_usage: { inputTokens: 10, outputTokens: 15 },
              },
            });
          }
          return makeVoterAction({ vote: 'A' }, {
            metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: {} },
          });
        }),
      });
      const ctx = makeDirectCtx({ deps });

      const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

      expect(action.metadata.token_usage).toEqual({ totalTokens: 25, inputTokens: 10, outputTokens: 15 });
      expect(action.metadata.model).toBe('claude-voter-model');
    });
  });

  it('falls back to agent_response when the configured vote_key is absent from a voter update', async () => {
    const node = makeVotingNode({
      voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
    });
    const deps = makeDirectDeps({
      executeAgent: vi.fn(async (agentId: string) => makeVoterAction({ agent_response: 'fallback-vote' }, {
        metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 10 } },
      })),
    });
    const ctx = makeDirectCtx({ deps });

    const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

    expect(action.payload.updates['vote-node_consensus']).toBe('fallback-vote');
  });

  it('propagates the node memory_query directive to each synthetic voter', async () => {
    const node = makeVotingNode({
      voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
      memory_query: { tags: ['lesson'] },
    });
    const executeAgent = vi.fn().mockResolvedValue(makeVoterAction({ vote: 'A' }));
    const ctx = makeDirectCtx({ deps: makeDirectDeps({ executeAgent }) });

    await executeVotingNode(node, makeDirectStateView(), 1, ctx);

    expect(executeAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      1,
      expect.objectContaining({ memoryQuery: expect.objectContaining({ tags: ['lesson'] }) }),
    );
  });

  it('passes modelOverride to voters when the model resolver returns one', async () => {
    const node = makeVotingNode({
      voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
    });
    const executeAgent = vi.fn().mockResolvedValue(makeVoterAction({ vote: 'A' }));
    const loadAgent = vi.fn().mockResolvedValue(makeAgentConfig({ model_preference: 'high' }));
    const modelResolver: ModelResolver = () => ({ reason: 'preferred', model: 'claude-opus-4-8', tier: 'high' });
    const ctx = makeDirectCtx({ deps: makeDirectDeps({ executeAgent, loadAgent }), modelResolver });

    await executeVotingNode(node, makeDirectStateView(), 1, ctx);

    expect(executeAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      1,
      expect.objectContaining({ modelOverride: 'claude-opus-4-8' }),
    );
  });

  it('marks consensus and votes keys tainted when a voter output was tainted', async () => {
    const node = makeVotingNode({
      voting_config: { voter_agent_ids: ['voter-a', 'voter-b'], strategy: 'majority_vote', vote_key: 'vote' },
    });
    const executeAgent = vi.fn(async (agentId: string) => makeVoterAction(
      agentId === 'voter-a'
        ? {
            vote: 'A',
            _taint_registry: {
              external_fact: { source: 'mcp', agent_id: agentId, created_at: '2026-06-11T00:00:00.000Z' },
            },
          }
        : { vote: 'A' },
      { metadata: { node_id: agentId, timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 10 } } },
    ));
    const ctx = makeDirectCtx({ deps: makeDirectDeps({ executeAgent }) });

    const action = await executeVotingNode(node, makeDirectStateView(), 1, ctx);

    expect(action.payload.updates['_taint_registry']).toEqual({
      'vote-node_consensus': { source: 'derived', agent_id: 'vote-node', created_at: expect.any(String) },
      'vote-node_votes': { source: 'derived', agent_id: 'vote-node', created_at: expect.any(String) },
    });
  });

  it('rejects the graph before execution when voting_config is missing (graph validation)', async () => {
    const graph: Graph = {
      id: 'bad-graph',
      name: 'Bad',
      description: 'Missing config',
      nodes: [{
        id: 'bad-vote',
        type: 'voting',
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
        requires_compensation: false,
      }],
      edges: [],
      start_node: 'bad-vote',
      end_nodes: ['bad-vote'],
    };

    const state = createState();
    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('missing voting_config');
  });

  it('throws when voting_config is missing, bypassing graph validation', async () => {
    const node = makeVotingNode();
    const ctx = makeDirectCtx();

    await expect(executeVotingNode(node, makeDirectStateView(), 1, ctx)).rejects.toThrow('missing voting_config');
  });
});
