import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (must come before imports that depend on them) ──────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/agent/evaluator-executor/executor', () => ({
  evaluateQualityExecutor: vi.fn(),
}));

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { checkAssertion } from '../src/evals/assertions.js';
import { runEval } from '../src/evals/runner.js';
import { evaluateQualityExecutor } from '../src/agent/evaluator-executor/executor.js';
import type { WorkflowState } from '../src/types/state.js';
import type { EvalAssertion, EvalSuite } from '../src/evals/types.js';
import type { Graph } from '../src/types/graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────

const createBaseState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test goal',
  constraints: [],
  status: 'completed',
  current_node: undefined,
  iteration_count: 3,
  retry_count: 0,
  max_retries: 3,
  memory: {
    result: 'hello world',
    count: 42,
    nested: { key: 'value' },
  },
  visited_nodes: ['start', 'middle', 'end'],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 500,
  max_token_budget: 1000,
  supervisor_history: [],
});

const createToolGraph = (nodeCount: number = 2): Graph => {
  const nodes = [];
  const edges = [];

  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node_${i}`;
    nodes.push({
      id: nodeId,
      type: 'tool' as const,
      tool_id: `mock_tool_${i}`,
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    });

    if (i > 0) {
      edges.push({
        id: `e_${i}`,
        source: `node_${i - 1}`,
        target: nodeId,
        condition: { type: 'always' as const },
      });
    }
  }

  return {
    id: uuidv4(),
    name: 'Test Tool Graph',
    description: 'Graph for eval tests',
    nodes,
    edges,
    start_node: 'node_0',
    end_nodes: [`node_${nodeCount - 1}`],
  };
};

// ─── Assertion Checker Tests ──────────────────────────────────────────

describe('checkAssertion', () => {
  describe('status_equals', () => {
    it('passes when status matches', async () => {
      const state = createBaseState();
      state.status = 'completed';

      const result = await checkAssertion(
        { type: 'status_equals', expected: 'completed' },
        state,
      );

      expect(result.passed).toBe(true);
      expect(result.actual).toBe('completed');
      expect(result.message).toBeUndefined();
    });

    it('fails when status does not match', async () => {
      const state = createBaseState();
      state.status = 'failed';

      const result = await checkAssertion(
        { type: 'status_equals', expected: 'completed' },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.actual).toBe('failed');
      expect(result.message).toContain('Expected status "completed"');
      expect(result.message).toContain('got "failed"');
    });
  });

  describe('memory_contains', () => {
    it('passes when key exists in memory', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        { type: 'memory_contains', key: 'result' },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails when key does not exist in memory', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        { type: 'memory_contains', key: 'nonexistent' },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Memory does not contain key "nonexistent"');
    });
  });

  describe('memory_matches', () => {
    it('passes with exact mode when values match', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'count',
          pattern: '',
          mode: 'exact',
          expected: 42,
        },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails with exact mode when values differ', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'count',
          pattern: '',
          mode: 'exact',
          expected: 99,
        },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('did not match (mode: exact)');
    });

    it('passes with contains mode for substring match', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'result',
          pattern: '',
          mode: 'contains',
          expected: 'hello',
        },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails with contains mode when substring not found', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'result',
          pattern: '',
          mode: 'contains',
          expected: 'goodbye',
        },
        state,
      );

      expect(result.passed).toBe(false);
    });

    it('passes with regex mode when pattern matches', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'result',
          pattern: '^hello\\s\\w+$',
          mode: 'regex',
          expected: undefined,
        },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails with regex mode when pattern does not match', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'result',
          pattern: '^goodbye',
          mode: 'regex',
          expected: undefined,
        },
        state,
      );

      expect(result.passed).toBe(false);
    });

    it('compares non-string values by JSON in contains mode', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'nested',
          pattern: '',
          mode: 'contains',
          expected: { key: 'value' },
        },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails regex mode when the memory value is not a string', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'count',
          pattern: '^42$',
          mode: 'regex',
          expected: undefined,
        },
        state,
      );

      expect(result.passed).toBe(false);
    });

    it('reports an invalid regex pattern instead of throwing', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'memory_matches',
          key: 'result',
          pattern: '(',
          mode: 'regex',
          expected: undefined,
        },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Invalid regex pattern: "("');
    });
  });

  describe('unknown assertion type', () => {
    it('fails closed for an unhandled assertion type', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        { type: 'not_a_real_type' } as unknown as EvalAssertion,
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toBe('Unknown assertion type');
    });
  });

  describe('node_visited', () => {
    it('passes when node was visited', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        { type: 'node_visited', node_id: 'middle' },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails when node was not visited', async () => {
      const state = createBaseState();

      const result = await checkAssertion(
        { type: 'node_visited', node_id: 'missing_node' },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Node "missing_node" was not visited');
      expect(result.message).toContain('start, middle, end');
    });
  });

  describe('token_budget_respected', () => {
    it('passes when within budget', async () => {
      const state = createBaseState();
      state.total_tokens_used = 500;
      state.max_token_budget = 1000;

      const result = await checkAssertion(
        { type: 'token_budget_respected' },
        state,
      );

      expect(result.passed).toBe(true);
    });

    it('fails when budget exceeded', async () => {
      const state = createBaseState();
      state.total_tokens_used = 1500;
      state.max_token_budget = 1000;

      const result = await checkAssertion(
        { type: 'token_budget_respected' },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Token budget exceeded');
      expect(result.message).toContain('1500/1000');
    });

    it('passes when no budget set', async () => {
      const state = createBaseState();
      state.total_tokens_used = 99999;
      state.max_token_budget = undefined;

      const result = await checkAssertion(
        { type: 'token_budget_respected' },
        state,
      );

      expect(result.passed).toBe(true);
    });
  });

  describe('llm_judge', () => {
    it('passes when LLM score meets threshold', async () => {
      const mockedEvaluateQuality = vi.mocked(evaluateQualityExecutor);
      mockedEvaluateQuality.mockResolvedValueOnce({
        score: 0.9,
        reasoning: 'Excellent output',
        tokens_used: 100,
      });

      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'llm_judge',
          criteria: 'Is the output good?',
          threshold: 0.7,
          evaluator_agent_id: 'eval-agent',
        },
        state,
      );

      expect(result.passed).toBe(true);
      expect(result.actual).toBe(0.9);
    });

    it('fails when LLM score below threshold', async () => {
      const mockedEvaluateQuality = vi.mocked(evaluateQualityExecutor);
      mockedEvaluateQuality.mockResolvedValueOnce({
        score: 0.3,
        reasoning: 'Poor quality',
        tokens_used: 100,
      });

      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'llm_judge',
          criteria: 'Is the output good?',
          threshold: 0.7,
          evaluator_agent_id: 'eval-agent',
        },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('LLM judge score 0.3 below threshold 0.7');
    });

    it('handles evaluator errors gracefully', async () => {
      const mockedEvaluateQuality = vi.mocked(evaluateQualityExecutor);
      mockedEvaluateQuality.mockRejectedValueOnce(new Error('LLM unavailable'));

      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'llm_judge',
          criteria: 'Is the output good?',
          threshold: 0.7,
          evaluator_agent_id: 'eval-agent',
        },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('LLM judge error: LLM unavailable');
    });

    it('stringifies a non-Error rejection from the evaluator', async () => {
      const mockedEvaluateQuality = vi.mocked(evaluateQualityExecutor);
      mockedEvaluateQuality.mockRejectedValueOnce('judge exploded');

      const state = createBaseState();

      const result = await checkAssertion(
        {
          type: 'llm_judge',
          criteria: 'Is the output good?',
          threshold: 0.7,
          evaluator_agent_id: 'eval-agent',
        },
        state,
      );

      expect(result.passed).toBe(false);
      expect(result.message).toContain('LLM judge error: judge exploded');
    });
  });
});

// ─── Eval Runner Tests ────────────────────────────────────────────────

describe('runEval', () => {
  it('all-passing suite returns overall_score 1.0', async () => {
    const suite: EvalSuite = {
      name: 'All Pass Suite',
      cases: [
        {
          name: 'Case A - tool nodes complete',
          graph: createToolGraph(2),
          input: { goal: 'Test all pass' },
          assertions: [
            { type: 'status_equals', expected: 'completed' },
            { type: 'node_visited', node_id: 'node_0' },
            { type: 'node_visited', node_id: 'node_1' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.suite_name).toBe('All Pass Suite');
    expect(report.overall_score).toBe(1.0);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.total).toBe(1);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.cases[0].passed).toBe(true);
    expect(report.cases[0].score).toBe(1.0);
  });

  it('partial failures return correct fractional score', async () => {
    const suite: EvalSuite = {
      name: 'Partial Fail Suite',
      cases: [
        {
          name: 'Case with partial assertions',
          graph: createToolGraph(2),
          input: { goal: 'Test partial' },
          assertions: [
            { type: 'status_equals', expected: 'completed' },
            { type: 'node_visited', node_id: 'node_0' },
            { type: 'node_visited', node_id: 'nonexistent_node' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(false);
    expect(report.cases[0].score).toBeCloseTo(2 / 3, 5);
    expect(report.overall_score).toBeCloseTo(2 / 3, 5);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
  });

  it('multiple cases with mixed results', async () => {
    const suite: EvalSuite = {
      name: 'Mixed Suite',
      cases: [
        {
          name: 'Passing case',
          graph: createToolGraph(1),
          input: { goal: 'Pass' },
          assertions: [
            { type: 'status_equals', expected: 'completed' },
          ],
        },
        {
          name: 'Failing case',
          graph: createToolGraph(1),
          input: { goal: 'Fail' },
          assertions: [
            { type: 'status_equals', expected: 'failed' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.overall_score).toBe(0.5);
  });

  it('workflow crash is caught and reported as error', async () => {
    const badGraph: Graph = {
      id: uuidv4(),
      name: 'Bad Graph',
      description: 'Graph with validation errors',
      nodes: [
        {
          id: 'only_node',
          type: 'tool',
          tool_id: 'mock_tool',
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'nonexistent_start',
      end_nodes: ['only_node'],
    };

    const suite: EvalSuite = {
      name: 'Error Suite',
      cases: [
        {
          name: 'Crash case',
          graph: badGraph,
          input: { goal: 'This will crash' },
          assertions: [
            { type: 'status_equals', expected: 'completed' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(false);
    expect(report.cases[0].score).toBe(0);
    expect(report.cases[0].error).toBeDefined();
    expect(report.cases[0].error).toContain('Graph validation failed');
  });

  it('empty suite returns zero score', async () => {
    const suite: EvalSuite = {
      name: 'Empty Suite',
      cases: [],
    };

    const report = await runEval(suite);

    expect(report.total).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.overall_score).toBe(0);
  });

  it('case with no assertions returns score 1.0', async () => {
    const suite: EvalSuite = {
      name: 'No Assertions',
      cases: [
        {
          name: 'No assertions case',
          graph: createToolGraph(1),
          input: { goal: 'Just run' },
          assertions: [],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(true);
    expect(report.cases[0].score).toBe(1.0);
    expect(report.overall_score).toBe(1.0);
  });

  it('memory_contains assertion works through runner', async () => {
    const suite: EvalSuite = {
      name: 'Memory Check',
      cases: [
        {
          name: 'Tool output in memory',
          graph: createToolGraph(1),
          input: { goal: 'Check memory' },
          assertions: [
            { type: 'memory_contains', key: 'node_0_result' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(true);
    expect(report.cases[0].assertions[0].passed).toBe(true);
  });

  it('token_budget_respected works through runner', async () => {
    const suite: EvalSuite = {
      name: 'Budget Check',
      cases: [
        {
          name: 'Token budget ok',
          graph: createToolGraph(1),
          input: { goal: 'Check budget', max_token_budget: 100000 },
          assertions: [
            { type: 'token_budget_respected' },
          ],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(true);
  });

  it('seeds string constraints from input, dropping non-string entries', async () => {
    const suite: EvalSuite = {
      name: 'Constraints Suite',
      cases: [
        {
          name: 'Case with constraints',
          graph: createToolGraph(1),
          input: { goal: 'Respect constraints', constraints: ['be fast', 42, 'be safe'] },
          assertions: [{ type: 'status_equals', expected: 'completed' }],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(true);
  });

  it('falls back to a default goal when input.goal is not a string', async () => {
    const suite: EvalSuite = {
      name: 'No Goal Suite',
      cases: [
        {
          name: 'Case without a goal',
          graph: createToolGraph(1),
          input: {},
          assertions: [{ type: 'status_equals', expected: 'completed' }],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.cases[0].passed).toBe(true);
  });

  it('duration_ms is tracked', async () => {
    const suite: EvalSuite = {
      name: 'Duration Suite',
      cases: [
        {
          name: 'Timing check',
          graph: createToolGraph(1),
          input: { goal: 'Time it' },
          assertions: [{ type: 'status_equals', expected: 'completed' }],
        },
      ],
    };

    const report = await runEval(suite);

    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.cases[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
