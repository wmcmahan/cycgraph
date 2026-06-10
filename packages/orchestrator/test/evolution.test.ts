import { describe, test, expect, vi, beforeEach } from 'vitest';
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

let candidateCallCount = 0;
const mockExecuteAgent = vi.fn();
vi.mock('../src/agent/agent-executor/executor.js', () => ({
  executeAgent: (...args: any[]) => mockExecuteAgent(...args),
}));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agent/evaluator-executor/executor.js', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agent/supervisor-executor/executor.js', () => ({ executeSupervisor: vi.fn() }));
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
import { EvolutionConfigSchema } from '../src/types/graph.js';
import { validateGraph } from '../src/validation/graph-validator.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

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

/**
 * Default agent mock: returns candidate output including the generation/index metadata.
 */
function setupDefaultAgentMock() {
  candidateCallCount = 0;
  mockExecuteAgent.mockImplementation(async (agentId: string, stateView: any, _tools: any, attempt: number) => {
    candidateCallCount++;
    const gen = stateView.memory._evolution_generation ?? 0;
    const idx = stateView.memory._evolution_candidate_index ?? 0;
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: {
        updates: {
          agent_response: `Candidate gen=${gen} idx=${idx}`,
          generation: gen,
          candidate_index: idx,
        },
      },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 30 },
      },
    };
  });
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Evolution (DGM) Node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultAgentMock();
  });

  // ── Schema tests ──────────────────────────────────────────────

  describe('EvolutionConfigSchema', () => {
    test('should parse valid config with defaults', () => {
      const result = EvolutionConfigSchema.parse({
        candidate_agent_id: 'writer',
        evaluator_agent_id: 'judge',
      });

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

    test('should reject population_size < 2', () => {
      const result = EvolutionConfigSchema.safeParse({
        population_size: 1,
        candidate_agent_id: 'writer',
        evaluator_agent_id: 'judge',
      });
      expect(result.success).toBe(false);
    });
  });

  // ── Validator tests ───────────────────────────────────────────

  describe('Graph Validator', () => {
    test('should error on missing evolution_config', () => {
      const graph: Graph = {
        id: 'bad-graph',
        name: 'Bad',
        description: 'Missing config',
        nodes: [{
          id: 'evo',
          type: 'evolution',
          // No evolution_config
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

    test('should error on elite_count >= population_size', () => {
      const graph = createEvolutionGraph({ elite_count: 3, population_size: 3 });
      const validation = validateGraph(graph);
      expect(validation.errors.some(e => e.includes('elite_count must be less than population_size'))).toBe(true);
    });

    test('should error on tournament_size > population_size', () => {
      const graph = createEvolutionGraph({
        selection_strategy: 'tournament',
        tournament_size: 10,
        population_size: 3,
      });
      const validation = validateGraph(graph);
      expect(validation.errors.some(e => e.includes('tournament_size exceeds population_size'))).toBe(true);
    });

    test('should warn on increasing temperature schedule', () => {
      const graph = createEvolutionGraph({
        initial_temperature: 0.3,
        final_temperature: 1.0,
      });
      const validation = validateGraph(graph);
      expect(validation.warnings.some(w => w.includes('temperature increases over generations'))).toBe(true);
    });
  });

  // ── Execution tests ───────────────────────────────────────────

  describe('Execution', () => {
    test('should complete when fitness threshold met in gen 0', async () => {
      // Evaluator returns high fitness immediately
      mockEvaluateQuality.mockResolvedValue({
        score: 0.95,
        reasoning: 'Excellent candidate',
        tokens_used: 20,
      });

      const graph = createEvolutionGraph({ max_generations: 5, fitness_threshold: 0.9 });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0.95);
      expect(finalState.memory['evo-node_generation']).toBe(1); // Only 1 generation needed
    });

    test('should stop at max_generations when threshold unreachable', async () => {
      // Evaluator always returns low fitness
      mockEvaluateQuality.mockResolvedValue({
        score: 0.3,
        reasoning: 'Poor quality',
        tokens_used: 20,
      });

      const graph = createEvolutionGraph({
        max_generations: 3,
        fitness_threshold: 0.99,
        stagnation_generations: 10, // Disable stagnation exit
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_generation']).toBe(3);
      expect((finalState.memory['evo-node_fitness_history'] as number[]).length).toBe(3);
    });

    test('stops early when the node token budget is reached mid-evolution (bounds overspend)', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.3, reasoning: 'meh', tokens_used: 20 });
      setupDefaultAgentMock(); // resets candidateCallCount

      // Each gen spends ~150 tokens (3 candidates × 30 + 3 evals × 20). The
      // between-generation guard stops once accumulated spend crosses the cap.
      // The runner's hard NodeBudgetExceededError still fires (the budget WAS
      // exceeded), but the guard means we run ~2 generations, not all 10.
      const graph = createEvolutionGraph({
        max_generations: 10,
        fitness_threshold: 0.99,
        stagnation_generations: 10, // disable stagnation exit
        population_size: 3,
      });
      graph.nodes[0].budget = { max_tokens: 200 };

      await expect(new GraphRunner(graph, createState()).run()).rejects.toThrow(/max_tokens/);

      // Without the guard the loop would run all 10 generations = 30 candidate
      // calls. The guard stops it after ~2 generations.
      expect(candidateCallCount).toBeLessThanOrEqual(6);
    });

    test('should detect stagnation and exit early', async () => {
      // Evaluator returns same fitness every time → stagnation
      mockEvaluateQuality.mockResolvedValue({
        score: 0.5,
        reasoning: 'Mediocre',
        tokens_used: 20,
      });

      const graph = createEvolutionGraph({
        max_generations: 10,
        fitness_threshold: 0.99,
        stagnation_generations: 2,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      // First gen finds best (0.5), gen 2 stagnation=1, gen 3 stagnation=2 → exit
      expect(finalState.memory['evo-node_generation']).toBeLessThanOrEqual(3);
    });

    test('should inject parent context in gen 1+ only', async () => {
      let evaluationCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evaluationCount++;
        // Return improving scores to prevent stagnation
        return { score: 0.3 + evaluationCount * 0.01, reasoning: 'ok', tokens_used: 10 };
      });

      const graph = createEvolutionGraph({
        max_generations: 2,
        fitness_threshold: 0.99,
        population_size: 2,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await runner.run();

      // Gen 0 candidates: no parent context
      const gen0Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 0
      );
      for (const call of gen0Calls) {
        expect(call[1].memory._evolution_parent).toBeUndefined();
        expect(call[1].memory._evolution_parent_fitness).toBeUndefined();
      }

      // Gen 1 candidates: parent context injected
      const gen1Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 1
      );
      for (const call of gen1Calls) {
        expect(call[1].memory._evolution_parent).toBeDefined();
        expect(call[1].memory._evolution_parent_fitness).toBeDefined();
      }
    });

    test('should not inject parent context in generation 0', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Great', tokens_used: 10 });

      const graph = createEvolutionGraph({ max_generations: 1, population_size: 2 });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await runner.run();

      for (const call of mockExecuteAgent.mock.calls) {
        const memory = call[1].memory;
        expect(memory._evolution_parent).toBeUndefined();
        expect(memory._evolution_parent_fitness).toBeUndefined();
        expect(memory._evolution_generation).toBe(0);
      }
    });

    test('should track total tokens across all generations', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Good', tokens_used: 20 });

      const graph = createEvolutionGraph({
        max_generations: 1,
        population_size: 3,
        fitness_threshold: 0.9,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      // 3 candidates × 30 tokens each + 3 evals × 20 tokens each = 150
      // Plus the merge_parallel_results action tracks total_tokens → reducer adds them
      expect(finalState.total_tokens_used).toBeGreaterThanOrEqual(150);
    });

    test('should pass temperature override with linear interpolation', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.3, reasoning: 'ok', tokens_used: 10 });

      const graph = createEvolutionGraph({
        max_generations: 3,
        population_size: 2,
        fitness_threshold: 0.99,
        initial_temperature: 1.0,
        final_temperature: 0.0,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await runner.run();

      // Gen 0: temp = 1.0, Gen 1: temp = 0.5, Gen 2: temp = 0.0
      const gen0Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 0
      );
      const gen1Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 1
      );
      const gen2Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 2
      );

      // Check temperature_override in options (5th arg)
      expect(gen0Calls[0][4].temperature_override).toBeCloseTo(1.0, 5);
      expect(gen1Calls[0][4].temperature_override).toBeCloseTo(0.5, 5);
      expect(gen2Calls[0][4].temperature_override).toBeCloseTo(0.0, 5);
    });

    test('should handle all candidates failing in best_effort mode', async () => {
      // All agents throw
      mockExecuteAgent.mockRejectedValue(new Error('Agent failure'));
      mockEvaluateQuality.mockResolvedValue({ score: 0.5, reasoning: 'ok', tokens_used: 10 });

      const graph = createEvolutionGraph({
        max_generations: 2,
        population_size: 2,
        error_strategy: 'best_effort',
        stagnation_generations: 2,
        fitness_threshold: 0.99,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      // Should complete without throwing (best_effort) — winner will be null
      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeNull();
    });

    test('should throw when all candidates fail in fail_fast mode', async () => {
      mockExecuteAgent.mockRejectedValue(new Error('Agent failure'));

      const graph = createEvolutionGraph({
        max_generations: 2,
        population_size: 2,
        error_strategy: 'fail_fast',
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await expect(runner.run()).rejects.toThrow();
    });

    test('should store fitness_history and final population in memory', async () => {
      let evalCall = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCall++;
        // Different scores for different candidates
        const score = 0.4 + (evalCall % 3) * 0.1;
        return { score, reasoning: `Score ${score}`, tokens_used: 15 };
      });

      const graph = createEvolutionGraph({
        max_generations: 2,
        population_size: 3,
        fitness_threshold: 0.99,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      const history = finalState.memory['evo-node_fitness_history'] as number[];
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(2);

      const population = finalState.memory['evo-node_population'] as any[];
      expect(Array.isArray(population)).toBe(true);
      expect(population.length).toBeGreaterThan(0);
      // Population should be sorted by fitness descending
      for (let i = 1; i < population.length; i++) {
        expect(population[i - 1].fitness).toBeGreaterThanOrEqual(population[i].fitness);
      }
    });
  });

  // ── Selection Strategy tests ───────────────────────────────────

  describe('Selection Strategies', () => {
    test('tournament selection should still track absolute best', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        // Candidates get different scores
        const score = 0.3 + (evalCount % 3) * 0.15;
        return { score, reasoning: `Score ${score}`, tokens_used: 10 };
      });

      const graph = createEvolutionGraph({
        selection_strategy: 'tournament',
        tournament_size: 2,
        max_generations: 2,
        population_size: 3,
        fitness_threshold: 0.99,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      // Winner should be the absolute best regardless of tournament selection
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBeGreaterThan(0);
    });

    test('roulette selection should still track absolute best', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        const score = 0.4 + (evalCount % 3) * 0.1;
        return { score, reasoning: `Score ${score}`, tokens_used: 10 };
      });

      const graph = createEvolutionGraph({
        selection_strategy: 'roulette',
        max_generations: 2,
        population_size: 3,
        fitness_threshold: 0.99,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner']).toBeDefined();
      expect(finalState.memory['evo-node_winner_fitness']).toBeGreaterThan(0);
    });

    test('tournament_size = population_size degenerates to rank selection', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.95, reasoning: 'Good', tokens_used: 10 });

      const graph = createEvolutionGraph({
        selection_strategy: 'tournament',
        tournament_size: 3,
        population_size: 3,
        max_generations: 1,
        fitness_threshold: 0.9,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0.95);
    });

    test('roulette with all-zero fitness falls back to first candidate', async () => {
      mockEvaluateQuality.mockResolvedValue({ score: 0.0, reasoning: 'Zero', tokens_used: 10 });

      const graph = createEvolutionGraph({
        selection_strategy: 'roulette',
        max_generations: 2,
        population_size: 3,
        fitness_threshold: 0.99,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      const finalState = await runner.run();

      // Should still complete without error (fallback to rank for parent selection)
      expect(finalState.status).toBe('completed');
      expect(finalState.memory['evo-node_winner_fitness']).toBe(0);
    });

    test('parent context in gen 1+ uses strategy-selected parent', async () => {
      let evalCount = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCount++;
        // Different scores so parent selection varies by strategy
        const score = 0.3 + (evalCount % 3) * 0.2;
        return { score, reasoning: 'ok', tokens_used: 10 };
      });

      const graph = createEvolutionGraph({
        selection_strategy: 'rank', // rank always picks best — deterministic
        max_generations: 2,
        population_size: 2,
        fitness_threshold: 0.99,
        stagnation_generations: 10,
      });
      const state = createState();

      const runner = new GraphRunner(graph, state);
      await runner.run();

      // Gen 1 candidates should have parent context injected
      const gen1Calls = mockExecuteAgent.mock.calls.filter(
        (call: any[]) => call[1].memory._evolution_generation === 1
      );
      for (const call of gen1Calls) {
        expect(call[1].memory._evolution_parent).toBeDefined();
        expect(call[1].memory._evolution_parent_fitness).toBeDefined();
      }
    });
  });

  // ── fitness_function callback ────────────────────────────────
  describe('fitnessFunction (deterministic evaluator)', () => {
    test('uses the runner-supplied fitnessFunction instead of the LLM judge', async () => {
      const fitnessFn = vi.fn(async (output: any) => ({
        // Score by the candidate index — gen 0 idx 2 wins, exits on threshold.
        score: 0.5 + (output.candidate_index ?? 0) * 0.2,
        reasoning: `scored idx=${output.candidate_index}`,
      }));

      const graph = createEvolutionGraph({
        population_size: 3,
        max_generations: 5,
        fitness_threshold: 0.85,
        // Evaluator agent intentionally omitted — fitnessFunction takes over.
        evaluator_agent_id: undefined,
      });
      const state = createState();
      const runner = new GraphRunner(graph, state, { fitnessFunction: fitnessFn });
      const finalState = await runner.run();

      // Should never call the LLM-as-judge
      expect(mockEvaluateQuality).not.toHaveBeenCalled();
      // fitnessFunction called once per candidate
      expect(fitnessFn).toHaveBeenCalled();
      // Best fitness recorded in fitness_history
      const history = finalState.memory['evo-node_fitness_history'] as number[];
      expect(history[0]).toBeCloseTo(0.9, 5); // 0.5 + 2*0.2 with idx 2
    });

    test('throws NodeConfigError when neither evaluator_agent_id nor fitnessFunction is provided', async () => {
      const graph = createEvolutionGraph({
        population_size: 2,
        max_generations: 1,
        evaluator_agent_id: undefined,
      });
      const state = createState();
      const runner = new GraphRunner(graph, state); // no fitnessFunction
      await expect(runner.run()).rejects.toThrow(/evaluator_agent_id or GraphRunnerOptions.fitnessFunction/);
    });

    test('fitnessFunction takes precedence over evaluator_agent_id when both are set', async () => {
      const fitnessFn = vi.fn(async () => ({ score: 0.99, reasoning: 'deterministic' }));
      const graph = createEvolutionGraph({
        population_size: 2,
        max_generations: 1,
        fitness_threshold: 0.95,
      });
      const state = createState();
      const runner = new GraphRunner(graph, state, { fitnessFunction: fitnessFn });
      await runner.run();

      expect(fitnessFn).toHaveBeenCalled();
      expect(mockEvaluateQuality).not.toHaveBeenCalled();
    });
  });
});
