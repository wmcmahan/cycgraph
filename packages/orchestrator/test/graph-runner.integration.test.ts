/**
 * graph-runner.integration.test.ts
 *
 * True integration tests that exercise the full pipeline:
 *   GraphRunner → real executeAgent → real reducers → real state management
 *
 * Only the LLM layer (streamText/generateText) is mocked. Everything else
 * is real: agent registry, agent executor, tool resolution, reducers.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const originalEnv = { ...process.env };
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key';
process.env.OPENAI_API_KEY = 'sk-test-fake-key';

// ─── Mock ONLY the LLM and infrastructure ─────────────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
  createOpenAI: vi.fn(() => (model: string) => ({ provider: 'openai', modelId: model })),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

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
vi.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import { streamText } from 'ai';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryAgentRegistry, InMemoryPersistenceProvider } from '../src/persistence/in-memory.js';
import { configureAgentFactory } from '../src/agents/factory/index.js';
import type { Graph } from '../src/graph/graph.js';
import { createTestState, makeNode } from './helpers/factories';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Create a mock streamText result that simulates an agent calling
 * the save_to_memory tool for each key-value pair.
 *
 * save_to_memory expects `{ key: string, value: unknown }` per call.
 */
function mockStreamResult(updates: Record<string, unknown>) {
  const entries = Object.entries(updates);
  const toolCalls = entries.map(([key, value]) => ({
    toolCallId: uuidv4(),
    toolName: 'save_to_memory',
    args: { key, value },
  }));
  const toolResults = toolCalls.map(tc => ({
    toolCallId: tc.toolCallId,
    result: 'Memory updated successfully',
  }));

  return {
    text: Promise.resolve('I have completed the task.'),
    usage: Promise.resolve({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
    totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
    steps: Promise.resolve([{ toolCalls, toolResults }]),
    textStream: (async function* () { yield 'done'; })(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────

afterAll(() => {
  process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
});

describe('GraphRunner — Integration Tests', () => {
  let registry: InMemoryAgentRegistry;
  let persistence: InMemoryPersistenceProvider;

  beforeEach(() => {
    vi.clearAllMocks();

    registry = new InMemoryAgentRegistry();
    configureAgentFactory(registry);

    persistence = new InMemoryPersistenceProvider();
  });

  it('2-node linear workflow: researcher → writer', async () => {
    const researcherId = registry.register({
      name: 'Researcher',
      description: 'Finds information',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'You are a researcher. Find facts and save them.',
      temperature: 0.5,
      max_steps: 5,
      tools: [{ type: 'builtin', name: 'save_to_memory' }],
      permissions: { read_keys: ['*'], write_keys: ['*'] },
    });

    const writerId = registry.register({
      name: 'Writer',
      description: 'Writes content from research',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'You are a writer. Use research findings to write content.',
      temperature: 0.7,
      max_steps: 5,
      tools: [{ type: 'builtin', name: 'save_to_memory' }],
      permissions: { read_keys: ['*'], write_keys: ['*'] },
    });

    const graph: Graph = {
      id: uuidv4(),
      name: 'Research & Write',
      description: 'Linear research-then-write workflow',
      nodes: [
        makeNode({ id: 'researcher', agent_id: researcherId }),
        makeNode({ id: 'writer', agent_id: writerId }),
      ],
      edges: [{
        id: 'e1', source: 'researcher', target: 'writer',
        condition: { type: 'always' },
      }],
      start_node: 'researcher',
      end_nodes: ['writer'],
    };

    const mockStreamText = vi.mocked(streamText);
    let callCount = 0;
    mockStreamText.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamResult({ research_findings: 'The sky is blue due to Rayleigh scattering.' }) as any;
      }
      return mockStreamResult({ final_output: 'The beautiful blue sky is caused by Rayleigh scattering of sunlight.' }) as any;
    });

    const persistFn = async (state: any) => {
      await persistence.saveWorkflowSnapshot(state);
    };

    const state = createTestState({ goal: 'Research and write about the sky' });
    const runner = new GraphRunner(graph, state, { persistStateFn: persistFn });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['researcher', 'writer']);

    expect(final.memory.research_findings).toBe('The sky is blue due to Rayleigh scattering.');
    expect(final.memory.final_output).toBe('The beautiful blue sky is caused by Rayleigh scattering of sunlight.');

    expect(final.total_tokens_used).toBeGreaterThan(0);

    const latestState = await persistence.loadLatestWorkflowState(state.run_id);
    expect(latestState).not.toBeNull();
  });

  it('single-node workflow completes correctly', async () => {
    const agentId = registry.register({
      name: 'Solo Agent',
      description: null,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'You are a helpful assistant.',
      temperature: 0.7,
      max_steps: 3,
      tools: [{ type: 'builtin', name: 'save_to_memory' }],
      permissions: { read_keys: ['*'], write_keys: ['*'] },
    });

    const graph: Graph = {
      id: uuidv4(),
      name: 'Single Node',
      description: 'Minimal workflow',
      nodes: [makeNode({ id: 'solo', agent_id: agentId })],
      edges: [],
      start_node: 'solo',
      end_nodes: ['solo'],
    };

    vi.mocked(streamText).mockImplementation(() =>
      mockStreamResult({ answer: '42' }) as any
    );

    const state = createTestState({ goal: 'Answer the question' });
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['solo']);
    expect(final.memory.answer).toBe('42');
    expect(final.iteration_count).toBe(1);
  });

  it('3-node chain with memory accumulation', async () => {
    const ids = ['analyzer', 'planner', 'executor'].map(name =>
      registry.register({
        name,
        description: null,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: `You are a ${name}.`,
        temperature: 0.7,
        max_steps: 3,
        tools: [{ type: 'builtin', name: 'save_to_memory' }],
        permissions: { read_keys: ['*'], write_keys: ['*'] },
      })
    );

    const graph: Graph = {
      id: uuidv4(),
      name: 'Three Step Pipeline',
      description: 'Analyzer → Planner → Executor',
      nodes: [
        makeNode({ id: 'analyze', agent_id: ids[0] }),
        makeNode({ id: 'plan', agent_id: ids[1] }),
        makeNode({ id: 'execute', agent_id: ids[2] }),
      ],
      edges: [
        { id: 'e1', source: 'analyze', target: 'plan', condition: { type: 'always' } },
        { id: 'e2', source: 'plan', target: 'execute', condition: { type: 'always' } },
      ],
      start_node: 'analyze',
      end_nodes: ['execute'],
    };

    let callCount = 0;
    vi.mocked(streamText).mockImplementation(() => {
      callCount++;
      const data: Record<string, unknown> = {
        1: { analysis: 'The problem is X' },
        2: { plan: 'Step 1: Fix X, Step 2: Verify' },
        3: { result: 'X has been fixed and verified' },
      };
      return mockStreamResult(data[callCount] ?? { done: true }) as any;
    });

    const state = createTestState({ goal: 'Fix X' });
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['analyze', 'plan', 'execute']);
    expect(final.iteration_count).toBe(3);
    expect(final.memory.analysis).toBe('The problem is X');
    expect(final.memory.plan).toBe('Step 1: Fix X, Step 2: Verify');
    expect(final.memory.result).toBe('X has been fixed and verified');
    expect(final.total_tokens_used).toBe(450);
  });
});
