import { describe, test, expect, vi } from 'vitest';
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
vi.mock('../src/agent/agent-executor/executor.js', () => ({
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

vi.mock('../src/agent/supervisor-executor/supervisor-executor.js', () => ({ executeSupervisor: vi.fn() }));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agent/evaluator-executor/executor.js', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────

describe('Voting/Consensus', () => {
  test('majority_vote should pick the most common vote', async () => {
    voterResponses = { 'voter-a': 'option_A', 'voter-b': 'option_A', 'voter-c': 'option_B' };

    const graph = createVotingGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory['vote-node_consensus']).toBe('option_A');
    expect(finalState.memory['vote-node_votes']).toBeDefined();
    expect((finalState.memory['vote-node_votes'] as any[]).length).toBe(3);
  });

  test('weighted_vote should respect weights', async () => {
    voterResponses = { 'voter-a': 'A', 'voter-b': 'B', 'voter-c': 'B' };

    const graph = createVotingGraph({
      strategy: 'weighted_vote',
      weights: { 'voter-a': 5, 'voter-b': 1, 'voter-c': 1 },
    });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // voter-a has weight 5, so A wins (5 vs 2)
    expect(finalState.memory['vote-node_consensus']).toBe('A');
  });

  test('llm_judge should use evaluator', async () => {
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
    );
  });

  test('forwards lesson provenance from every voter into the merged action', async () => {
    voterResponses = { 'voter-a': 'A', 'voter-b': 'A', 'voter-c': 'B' };

    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    const origMock = (executeAgent as any).getMockImplementation();
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
      const registry = finalState.memory['_lesson_provenance'] as Record<string, any>;
      expect(Object.keys(registry).sort()).toEqual(['entry-voter-a', 'entry-voter-b', 'entry-voter-c']);
      expect(registry['entry-voter-b'].fact_ids).toEqual(['fact-voter-b']);
      // Provenance never leaks into the consensus/vote outputs.
      const votes = finalState.memory['vote-node_votes'] as Array<{ vote: unknown }>;
      expect(votes.every((v) => typeof v.vote === 'string')).toBe(true);
    } finally {
      (executeAgent as any).mockImplementation(origMock);
    }
  });

  test('should fail when quorum not met', async () => {
    // Make one voter fail
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    const origMock = (executeAgent as any).getMockImplementation();
    let callNum = 0;
    (executeAgent as any).mockImplementation(async (...args: any[]) => {
      callNum++;
      if (callNum === 2) throw new Error('Voter unavailable');
      return origMock!(...args);
    });

    const graph = createVotingGraph({ quorum: 3 }); // All 3 must vote
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('quorum');

    // Restore
    (executeAgent as any).mockImplementation(origMock);
  });

  test('should track total tokens from all voters', async () => {
    voterResponses = { 'voter-a': 'A', 'voter-b': 'A', 'voter-c': 'B' };

    const graph = createVotingGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // 3 voters × 25 = 75, counted exactly once. Exact equality guards against
    // the fan-out double-count regression (previously 150).
    expect(finalState.total_tokens_used).toBe(75);
  });

  test('should error without voting_config', async () => {
    const graph: Graph = {
      id: 'bad-graph',
      name: 'Bad',
      description: 'Missing config',
      nodes: [{
        id: 'bad-vote',
        type: 'voting',
        // No voting_config
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

  test('llm_judge should error without judge_agent_id', async () => {
    voterResponses = { 'voter-a': 'A', 'voter-b': 'B', 'voter-c': 'A' };

    const graph = createVotingGraph({
      strategy: 'llm_judge',
      // No judge_agent_id
    });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('judge_agent_id');
  });

  test('unanimous vote should show single consensus value', async () => {
    voterResponses = { 'voter-a': 'same', 'voter-b': 'same', 'voter-c': 'same' };

    const graph = createVotingGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.memory['vote-node_consensus']).toBe('same');
  });

  // ── Canonical vote comparison tests ─────────────────────────────

  describe('Canonical vote comparison', () => {
    test('majority_vote: objects with different key ordering should match', async () => {
      // Mock voters to return objects with different key orderings
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const voteKey = stateView.memory._vote_key || 'vote';
        // voter-a and voter-c return {a:1,b:2} but in different key orders
        let vote: any;
        if (agentId === 'voter-a') vote = { a: 1, b: 2 };
        else if (agentId === 'voter-b') vote = { x: 99 };
        else vote = { b: 2, a: 1 }; // Same content, different key order
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [voteKey]: vote } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
        };
      });

      const graph = createVotingGraph();
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      // {a:1,b:2} should win (2 votes vs 1 for {x:99})
      const consensus = finalState.memory['vote-node_consensus'] as any;
      expect(consensus).toEqual({ a: 1, b: 2 });
    });

    test('weighted_vote: nested objects with different key ordering should match', async () => {
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const voteKey = stateView.memory._vote_key || 'vote';
        let vote: any;
        if (agentId === 'voter-a') vote = { outer: { z: 3, a: 1 } };
        else if (agentId === 'voter-b') vote = { different: true };
        else vote = { outer: { a: 1, z: 3 } }; // Same nested, different order
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [voteKey]: vote } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
        };
      });

      const graph = createVotingGraph({
        strategy: 'weighted_vote',
        weights: { 'voter-a': 1, 'voter-b': 1, 'voter-c': 1 },
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      // Nested objects with same content but different key order should match
      const consensus = finalState.memory['vote-node_consensus'] as any;
      expect(consensus.outer).toEqual({ z: 3, a: 1 });
    });

    test('primitive votes still work correctly', async () => {
      // Restore default mock after object-vote tests overrode it
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const voteKey = stateView.memory._vote_key || 'vote';
        const vote = voterResponses[agentId] || 'default_vote';
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [voteKey]: vote } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
        };
      });

      voterResponses = { 'voter-a': 'yes', 'voter-b': 'no', 'voter-c': 'yes' };

      const graph = createVotingGraph();
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.memory['vote-node_consensus']).toBe('yes');
    });
  });
});
