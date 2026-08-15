/**
 * Evolution (DGM) node: EvolutionConfigSchema, graph validation, and
 * executeEvolutionNode — population-based Darwinian selection exercised
 * through GraphRunner (integration) and via direct calls (unit, for the
 * abort/budget/taint/provenance branches the integration path can't reach
 * deterministically).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

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

let candidateCallCount = 0;
const mockExecuteAgent = vi.fn();
vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: (...args: any[]) => mockExecuteAgent(...args),
}));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agents/executors/evaluator/executor.js', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agents/executors/supervisor/executor.js', () => ({ executeSupervisor: vi.fn() }));
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
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { executeEvolutionNode } from '../src/execution/nodes/evolution.js';
import { EvolutionConfigSchema } from '../src/graph/graph.js';
import { validateGraph } from '../src/graph/graph-validator.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState, StateView, Action } from '../src/state/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/execution/nodes/context.js';

const createState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Evolution test',
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

const createEvolutionGraph = (configOverrides: any = {}): Graph => ({
  id: 'evolution-graph',
  name: 'Evolution Test',
  description: 'Test DGM evolution',
  nodes: [{
    id: 'evo-node',
    type: 'evolution',
    evolution_config: {
      population_size: 3,
      candidate_agent_id: 'candidate-agent',
      evaluator_agent_id: 'eval-agent',
      selection_strategy: 'rank',
      elite_count: 1,
      max_generations: 5,
      fitness_threshold: 0.9,
      stagnation_generations: 3,
      initial_temperature: 1.0,
      final_temperature: 0.3,
      tournament_size: 2,
      max_concurrency: 3,
      error_strategy: 'best_effort',
      ...configOverrides,
    },
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
  }],
  edges: [],
  start_node: 'evo-node',
  end_nodes: ['evo-node'],
});

function setupDefaultAgentMock() {
  candidateCallCount = 0;
  mockExecuteAgent.mockImplementation(async (agentId: string, stateView: any, _tools: any, attempt: number) => {
    candidateCallCount++;
    const gen = stateView.taskContext?.generation ?? 0;
    const idx = stateView.taskContext?.candidate_index ?? 0;
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { agent_response: `Candidate gen=${gen} idx=${idx}`, generation: gen, candidate_index: idx } },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 30 },
      },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultAgentMock();
});

describe('EvolutionConfigSchema', () => {
  it('parses a valid config and applies defaults', () => {
    const result = EvolutionConfigSchema.parse({ candidate_agent_id: 'writer', evaluator_agent_id: 'judge' });

    expect(result.population_size).toBe(5);
    expect(result.selection_strategy).toBe('rank');
    expect(result.elite_count).toBe(1);
    expect(result.max_generations).toBe(10);
    expect(result.fitness_threshold).toBe(0.9);
    expect(result.stagnation_generations).toBe(3);
    expect(result.initial_temperature).toBe(1.0);
    expect(result.final_temperature).toBe(0.3);
    expect(result.tournament_size).toBe(3);
    expect(result.max_concurrency).toBe(5);
    expect(result.error_strategy).toBe('best_effort');
  });

  it('rejects a population_size below 2', () => {
    const result = EvolutionConfigSchema.safeParse({
      population_size: 1,
      candidate_agent_id: 'writer',
      evaluator_agent_id: 'judge',
    });

    expect(result.success).toBe(false);
  });
});

describe('validateGraph (evolution nodes)', () => {
  it('reports a missing evolution_config', () => {
    const graph: Graph = {
      id: 'bad-graph',
      name: 'Bad',
      description: 'Missing config',
      nodes: [{
        id: 'evo',
        type: 'evolution',
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
        requires_compensation: false,
      }],
      edges: [],
      start_node: 'evo',
      end_nodes: ['evo'],
    };

    const validation = validateGraph(graph);

    expect(validation.errors).toContain("Evolution node 'evo' is missing evolution_config");
  });

  it('rejects elite_count greater than or equal to population_size', () => {
    const validation = validateGraph(createEvolutionGraph({ elite_count: 3, population_size: 3 }));

    expect(validation.errors.some(e => e.includes('elite_count must be less than population_size'))).toBe(true);
  });

  it('rejects tournament_size greater than population_size', () => {
    const validation = validateGraph(createEvolutionGraph({ selection_strategy: 'tournament', tournament_size: 10, population_size: 3 }));

    expect(validation.errors.some(e => e.includes('tournament_size exceeds population_size'))).toBe(true);
  });

  it('warns on an increasing temperature schedule', () => {
    const validation = validateGraph(createEvolutionGraph({ initial_temperature: 0.3, final_temperature: 1.0 }));

    expect(validation.warnings.some(w => w.includes('temperature increases over generations'))).toBe(true);
  });
});

describe('executeEvolutionNode', () => {
  describe('via GraphRunner', () => {
    it('completes when the fitness threshold is met in generation 0', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Excellent candidate', tokensUsed: 20 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 5, fitness_threshold: 0.9 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0.95);
      expect(finalState.memory['evo-node_generation']).toBe(1);
    });

    it('stops at max_generations when the threshold is unreachable', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.3, reasoning: 'Poor quality', tokensUsed: 20 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 3, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_generation']).toBe(3);
      expect((finalState.memory['evo-node_fitness_history'] as number[]).length).toBe(3);
    });

    it('stops early when the node token budget is reached mid-evolution', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.3, reasoning: 'meh', tokensUsed: 20 });
      setupDefaultAgentMock();
      const graph = createEvolutionGraph({ max_generations: 10, fitness_threshold: 0.99, stagnation_generations: 10, population_size: 3 });
      graph.nodes[0].budget = { max_tokens: 200 };

      await expect(new GraphRunner(graph, createState()).run()).rejects.toThrow(/max_tokens/);

      expect(candidateCallCount).toBeLessThanOrEqual(6);
    });

    it('detects stagnation and exits early', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.5, reasoning: 'Mediocre', tokensUsed: 20 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 10, fitness_threshold: 0.99, stagnation_generations: 2 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_generation']).toBeLessThanOrEqual(3);
    });

    it('injects parent context in generation 1 and later', async () => {
      let evaluationCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evaluationCount++;
        return { score: 0.3 + evaluationCount * 0.01, reasoning: 'ok', tokensUsed: 10 };
      });

      await new GraphRunner(
        createEvolutionGraph({ max_generations: 2, fitness_threshold: 0.99, population_size: 2, stagnation_generations: 10 }),
        createState(),
      ).run();

      const gen0Calls = mockExecuteAgent.mock.calls.filter((call: any[]) => call[1].taskContext?.generation === 0);
      for (const call of gen0Calls) {
        expect(call[1].taskContext?.parent).toBeUndefined();
        expect(call[1].taskContext?.parent_fitness).toBeUndefined();
      }
      const gen1Calls = mockExecuteAgent.mock.calls.filter((call: any[]) => call[1].taskContext?.generation === 1);
      for (const call of gen1Calls) {
        expect(call[1].taskContext?.parent).toBeDefined();
        expect(call[1].taskContext?.parent_fitness).toBeDefined();
      }
    });

    it('omits parent context in generation 0', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Great', tokensUsed: 10 });

      await new GraphRunner(createEvolutionGraph({ max_generations: 1, population_size: 2 }), createState()).run();

      for (const call of mockExecuteAgent.mock.calls) {
        expect(call[1].taskContext?.parent).toBeUndefined();
        expect(call[1].taskContext?.parent_fitness).toBeUndefined();
        expect(call[1].taskContext?.generation).toBe(0);
      }
    });

    it('accumulates total tokens across all generations exactly once', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Good', tokensUsed: 20 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 1, population_size: 3, fitness_threshold: 0.9 }),
        createState(),
      ).run();

      expect(finalState.total_tokens_used).toBe(150);
    });

    it('passes a linearly interpolated temperature override', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.3, reasoning: 'ok', tokensUsed: 10 });

      await new GraphRunner(
        createEvolutionGraph({ max_generations: 3, population_size: 2, fitness_threshold: 0.99, initial_temperature: 1.0, final_temperature: 0.0, stagnation_generations: 10 }),
        createState(),
      ).run();

      const genCalls = (g: number) => mockExecuteAgent.mock.calls.filter((call: any[]) => call[1].taskContext?.generation === g);
      expect(genCalls(0)[0][4].temperatureOverride).toBeCloseTo(1.0, 5);
      expect(genCalls(1)[0][4].temperatureOverride).toBeCloseTo(0.5, 5);
      expect(genCalls(2)[0][4].temperatureOverride).toBeCloseTo(0.0, 5);
    });

    it('completes with a null winner when all candidates fail in best_effort mode', async () => {
      mockExecuteAgent.mockRejectedValue(new Error('Agent failure'));
      mockEvaluateQuality.mockResolvedValue({ score: 0.5, reasoning: 'ok', tokensUsed: 10 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 2, population_size: 2, error_strategy: 'best_effort', stagnation_generations: 2, fitness_threshold: 0.99 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeNull();
    });

    it('throws when all candidates fail in fail_fast mode', async () => {
      mockExecuteAgent.mockRejectedValue(new Error('Agent failure'));

      const runner = new GraphRunner(
        createEvolutionGraph({ max_generations: 2, population_size: 2, error_strategy: 'fail_fast' }),
        createState(),
      );

      await expect(runner.run()).rejects.toThrow();
    });

    it('stores fitness history and the final population sorted by fitness', async () => {
      let evalCall = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCall++;
        const score = 0.4 + (evalCall % 3) * 0.1;
        return { score, reasoning: `Score ${score}`, tokensUsed: 15 };
      });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ max_generations: 2, population_size: 3, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      const history = finalState.memory['evo-node_fitness_history'] as number[];
      expect(history.length).toBe(2);
      const population = finalState.memory['evo-node_population'] as any[];
      expect(population.length).toBeGreaterThan(0);
      for (let i = 1; i < population.length; i++) {
        expect(population[i - 1].fitness).toBeGreaterThanOrEqual(population[i].fitness);
      }
    });
  });

  describe('selection strategies', () => {
    it('tracks the absolute best under tournament selection', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        const score = 0.3 + (evalCount % 3) * 0.15;
        return { score, reasoning: `Score ${score}`, tokensUsed: 10 };
      });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ selection_strategy: 'tournament', tournament_size: 2, max_generations: 2, population_size: 3, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBeGreaterThan(0);
    });

    it('tracks the absolute best under roulette selection', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        const score = 0.4 + (evalCount % 3) * 0.1;
        return { score, reasoning: `Score ${score}`, tokensUsed: 10 };
      });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ selection_strategy: 'roulette', max_generations: 2, population_size: 3, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBeGreaterThan(0);
    });

    it('degenerates to rank when tournament_size equals population_size', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Good', tokensUsed: 10 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ selection_strategy: 'tournament', tournament_size: 3, population_size: 3, max_generations: 1, fitness_threshold: 0.9 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0.95);
    });

    it('falls back to the first candidate under roulette when all fitness is zero', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.0, reasoning: 'Zero', tokensUsed: 10 });

      const finalState = await new GraphRunner(
        createEvolutionGraph({ selection_strategy: 'roulette', max_generations: 2, population_size: 3, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0);
    });

    it('uses the strategy-selected parent for generation 1 breeding', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        const score = 0.3 + (evalCount % 3) * 0.2;
        return { score, reasoning: 'ok', tokensUsed: 10 };
      });

      await new GraphRunner(
        createEvolutionGraph({ selection_strategy: 'rank', max_generations: 2, population_size: 2, fitness_threshold: 0.99, stagnation_generations: 10 }),
        createState(),
      ).run();

      const gen1Calls = mockExecuteAgent.mock.calls.filter((call: any[]) => call[1].taskContext?.generation === 1);
      for (const call of gen1Calls) {
        expect(call[1].taskContext?.parent).toBeDefined();
        expect(call[1].taskContext?.parent_fitness).toBeDefined();
      }
    });
  });

  describe('fitnessFunction', () => {
    it('uses the runner-supplied fitness function instead of the LLM judge', async () => {
      const fitnessFn = vi.fn(async (output: any) => ({
        score: 0.5 + (output.candidate_index ?? 0) * 0.2,
        reasoning: `scored idx=${output.candidate_index}`,
      }));

      const finalState = await new GraphRunner(
        createEvolutionGraph({ population_size: 3, max_generations: 5, fitness_threshold: 0.85, evaluator_agent_id: undefined }),
        createState(),
        { fitnessFunction: fitnessFn },
      ).run();

      expect(mockEvaluateQuality).not.toHaveBeenCalled();
      expect(fitnessFn).toHaveBeenCalled();
      expect((finalState.memory['evo-node_fitness_history'] as number[])[0]).toBeCloseTo(0.9, 5);
    });

    it('throws when neither evaluator_agent_id nor fitnessFunction is provided', async () => {
      const runner = new GraphRunner(
        createEvolutionGraph({ population_size: 2, max_generations: 1, evaluator_agent_id: undefined }),
        createState(),
      );

      await expect(runner.run()).rejects.toThrow(/evaluator_agent_id or GraphRunnerOptions.fitnessFunction/);
    });

    it('prefers the fitness function over evaluator_agent_id when both are set', async () => {
      const fitnessFn = vi.fn(async () => ({ score: 0.99, reasoning: 'deterministic' }));

      await new GraphRunner(
        createEvolutionGraph({ population_size: 2, max_generations: 1, fitness_threshold: 0.95 }),
        createState(),
        { fitnessFunction: fitnessFn },
      ).run();

      expect(fitnessFn).toHaveBeenCalled();
      expect(mockEvaluateQuality).not.toHaveBeenCalled();
    });
  });

  describe('elitism', () => {
    const decliningFitness = () =>
      vi.fn(async (output: any) => ({
        score: (output.generation ?? 0) === 0 ? 0.8 : 0.2,
        reasoning: `gen ${output.generation}`,
      }));

    it('keeps best fitness monotonic when later generations are worse', async () => {
      const finalState = await new GraphRunner(
        createEvolutionGraph({ population_size: 3, elite_count: 1, max_generations: 3, fitness_threshold: 0.99, stagnation_generations: 10, evaluator_agent_id: undefined }),
        createState(),
        { fitnessFunction: decliningFitness() },
      ).run();

      const history = finalState.memory['evo-node_fitness_history'] as number[];
      expect(history.length).toBe(3);
      for (let i = 1; i < history.length; i++) {
        expect(history[i]).toBeGreaterThanOrEqual(history[i - 1]);
      }
      expect(history[0]).toBeCloseTo(0.8, 5);
      expect(history[1]).toBeCloseTo(0.8, 5);
      expect(finalState.memory['evo-node_winner_fitness']).toBeCloseTo(0.8, 5);
    });

    it('does not re-generate carried-forward elites', async () => {
      setupDefaultAgentMock();

      await new GraphRunner(
        createEvolutionGraph({ population_size: 3, elite_count: 1, max_generations: 3, fitness_threshold: 0.99, stagnation_generations: 10, evaluator_agent_id: undefined }),
        createState(),
        { fitnessFunction: decliningFitness() },
      ).run();

      expect(candidateCallCount).toBe(7);
    });

    it('marks the surviving candidate as elite in the population summary', async () => {
      const finalState = await new GraphRunner(
        createEvolutionGraph({ population_size: 3, elite_count: 1, max_generations: 2, fitness_threshold: 0.99, stagnation_generations: 10, evaluator_agent_id: undefined }),
        createState(),
        { fitnessFunction: decliningFitness() },
      ).run();

      const population = finalState.memory['evo-node_population'] as Array<{ is_elite?: boolean }>;
      expect(population.some((c) => c.is_elite === true)).toBe(true);
    });

    it('drops best fitness on a worse generation when elite_count is zero', async () => {
      const finalState = await new GraphRunner(
        createEvolutionGraph({ population_size: 3, elite_count: 0, max_generations: 2, fitness_threshold: 0.99, stagnation_generations: 10, evaluator_agent_id: undefined }),
        createState(),
        { fitnessFunction: decliningFitness() },
      ).run();

      const history = finalState.memory['evo-node_fitness_history'] as number[];
      expect(history[0]).toBeCloseTo(0.8, 5);
      expect(history[1]).toBeCloseTo(0.2, 5);
    });
  });

  describe('direct invocation', () => {
    const makeNode = (config: any = {}, overrides: Partial<GraphNode> = {}): GraphNode => ({
      id: 'evo',
      type: 'evolution',
      read_keys: ['*'],
      write_keys: ['*'],
      evolution_config: {
        population_size: 2,
        candidate_agent_id: 'candidate-agent',
        evaluator_agent_id: 'eval-agent',
        selection_strategy: 'rank',
        elite_count: 0,
        max_generations: 1,
        fitness_threshold: 0.9,
        stagnation_generations: 3,
        initial_temperature: 1.0,
        final_temperature: 0.3,
        tournament_size: 2,
        max_concurrency: 2,
        error_strategy: 'best_effort',
        ...config,
      },
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
      ...overrides,
    } as GraphNode);

    const makeStateView = (): StateView => ({
      workflow_id: 'wf-1', run_id: 'run-1', goal: 'g', constraints: [], memory: {},
    });

    const candidateAction = (sv: any, extraUpdates: Record<string, unknown> = {}, metaExtra: Record<string, unknown> = {}): Action => ({
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: {
        updates: {
          agent_response: 'candidate',
          generation: sv.taskContext?.generation ?? 0,
          candidate_index: sv.taskContext?.candidate_index ?? 0,
          ...extraUpdates,
        },
      },
      metadata: { node_id: 'c', timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 30 }, ...metaExtra },
    } as Action);

    const makeDeps = (overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies => ({
      executeAgent: vi.fn(async (_id: string, sv: any) => candidateAction(sv)),
      executeSupervisor: vi.fn(),
      evaluateQualityExecutor: vi.fn(),
      resolveTools: vi.fn().mockResolvedValue({}),
      loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      getTaintRegistry: vi.fn().mockReturnValue({}),
      ...overrides,
    });

    const passFitness = async () => ({ score: 0.95, reasoning: 'r' });

    const makeCtx = (overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext => ({
      state: createState(),
      graph: { id: 'g-1', name: 'Test', nodes: [], edges: [], start_node: 's', metadata: {} } as any,
      createStateView: () => makeStateView(),
      deps: makeDeps(),
      fitnessFunction: passFitness,
      ...overrides,
    });

    it('throws when evolution_config is missing', async () => {
      const node = makeNode();
      (node as any).evolution_config = undefined;

      await expect(executeEvolutionNode(node, makeStateView(), 1, makeCtx())).rejects.toThrow('evolution_config');
    });

    it('stops immediately when the abort signal is already aborted', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ deps, abortSignal: AbortSignal.abort() });

      const action = await executeEvolutionNode(makeNode(), makeStateView(), 1, ctx);

      expect(deps.executeAgent).not.toHaveBeenCalled();
      expect((action.payload.updates as Record<string, unknown>).evo_winner).toBeNull();
    });

    it('selects the sole candidate when the population holds one', async () => {
      const node = makeNode({ population_size: 1, elite_count: 0, max_generations: 1, fitness_threshold: 0.9 });

      const action = await executeEvolutionNode(node, makeStateView(), 1, makeCtx());

      expect((action.payload.updates as Record<string, unknown>).evo_winner_fitness).toBe(0.95);
    });

    it('falls back to the top candidate for an unrecognized selection strategy', async () => {
      const fitnessFunction = vi.fn(async (o: any) => ({ score: 0.4 + (o.candidate_index ?? 0) * 0.1, reasoning: 'r' }));
      const node = makeNode({ selection_strategy: 'invalid' as any, population_size: 3, max_generations: 2, fitness_threshold: 0.99, stagnation_generations: 10 });

      const action = await executeEvolutionNode(node, makeStateView(), 1, makeCtx({ fitnessFunction }));

      expect((action.payload.updates as Record<string, unknown>).evo_generation).toBe(2);
    });

    it('unions lesson provenance from candidates into the merged action', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) =>
          candidateAction(sv, { _lesson_provenance: { 'entry-1': { fact_ids: ['f1'] } } })),
      });

      const action = await executeEvolutionNode(makeNode(), makeStateView(), 1, makeCtx({ deps }));

      expect((action.payload.updates as Record<string, unknown>)._lesson_provenance).toMatchObject({ 'entry-1': { fact_ids: ['f1'] } });
    });

    it('marks aggregate keys tainted when a candidate output was tainted', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) =>
          candidateAction(sv, { _taint_registry: { ext: { source: 'mcp', agent_id: 'c', created_at: '2026-01-01T00:00:00.000Z' } } })),
      });

      const action = await executeEvolutionNode(makeNode(), makeStateView(), 1, makeCtx({ deps }));

      expect((action.payload.updates as Record<string, unknown>)._taint_registry).toMatchObject({
        evo_winner: { source: 'derived' },
        evo_population: { source: 'derived' },
      });
    });

    it('derives candidate tokens from input and output when totalTokens is absent', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) =>
          candidateAction(sv, {}, { token_usage: { inputTokens: 4, outputTokens: 6 } })),
      });
      const node = makeNode({ population_size: 1, elite_count: 0, max_generations: 1 });

      const action = await executeEvolutionNode(node, makeStateView(), 1, makeCtx({ deps }));

      expect(action.metadata.token_usage).toEqual({ totalTokens: 10, inputTokens: 4, outputTokens: 6 });
    });

    it('records the first candidate model in the aggregate metadata', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) => candidateAction(sv, {}, { model: 'evo-model' })),
      });
      const node = makeNode({ population_size: 1, elite_count: 0, max_generations: 1 });

      const action = await executeEvolutionNode(node, makeStateView(), 1, makeCtx({ deps }));

      expect(action.metadata.model).toBe('evo-model');
    });

    it('forwards a resolved modelOverride to candidate agents', async () => {
      const deps = makeDeps({
        loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6', model_preference: 'high' }),
      });
      const ctx = makeCtx({ deps, modelResolver: (() => ({ model: 'claude-opus-4-8', reason: 'high-tier' })) as any, remainingBudgetUsd: 100 });

      await executeEvolutionNode(makeNode(), makeStateView(), 1, ctx);

      expect((deps.executeAgent as any).mock.calls[0][4].modelOverride).toBe('claude-opus-4-8');
    });

    it('propagates the node memory_query to each synthetic candidate', async () => {
      const deps = makeDeps();
      const node = makeNode({}, { memory_query: { tags: ['lesson'] } } as any);

      await executeEvolutionNode(node, makeStateView(), 1, makeCtx({ deps }));

      expect((deps.executeAgent as any).mock.calls[0][4].memoryQuery).toMatchObject({ tags: ['lesson'] });
    });

    it('defaults winner reasoning to empty when the fitness function omits it', async () => {
      const fitnessFunction = vi.fn(async () => ({ score: 0.95 }));

      const action = await executeEvolutionNode(makeNode(), makeStateView(), 1, makeCtx({ fitnessFunction }));

      expect((action.payload.updates as Record<string, unknown>).evo_winner_reasoning).toBe('');
    });
  });
});
