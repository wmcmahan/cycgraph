/**
 * Tests for the agent `maxOutputTokens` generation cap.
 *
 * The cap has no default on purpose: an unset value must reach the provider
 * as an absent key so existing graphs keep the provider's own behaviour.
 * These cover the schema, the four executor paths that call a provider, and
 * the authoring pass-through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateText, streamText } from 'ai';
import { AgentConfigSchema } from '../src/agents/types.js';
import type { AgentConfig } from '../src/agents/types.js';
import type { AgentFactory } from '../src/agents/factory/agent-factory.js';
import { evaluateQualityExecutor } from '../src/agents/executors/evaluator/executor.js';
import { extractFactsExecutor } from '../src/agents/executors/extractor/executor.js';
import { executeSupervisor } from '../src/agents/executors/supervisor/executor.js';
import { executeAgent } from '../src/agents/executors/agent/executor.js';
import { agent, toRegistryConfig } from '../src/authoring/agent.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { StateView } from '../src/state/state.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/observability/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: unknown, _name: string, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: vi.fn() }),
}));

const BASE_CONFIG: AgentConfig = {
  id: 'a-1',
  name: 'Agent',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system: 'You are helpful.',
  temperature: 0.3,
  maxSteps: 1,
  tools: [],
  read_keys: ['*'],
  write_keys: [],
} as AgentConfig;

function factoryWith(overrides: Partial<AgentConfig>): AgentFactory {
  return {
    loadAgent: vi.fn().mockResolvedValue({ ...BASE_CONFIG, ...overrides }),
    getModel: vi.fn().mockReturnValue({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' }),
  } as unknown as AgentFactory;
}

function stateView(): StateView {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000001',
    run_id: '00000000-0000-0000-0000-000000000002',
    goal: 'do the thing',
    constraints: [],
    memory: {},
    status: 'running',
    iteration: 0,
  } as unknown as StateView;
}

function supervisorNode(): GraphNode {
  return {
    id: 'boss',
    type: 'supervisor',
    agent_id: 'a-1',
    read_keys: [],
    write_keys: [],
    requires_compensation: false,
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
    supervisor_config: { managed_nodes: ['w'], max_iterations: 3 },
  } as unknown as GraphNode;
}

/** The options object the mocked provider call received. */
function callArgs(spy: typeof generateText | typeof streamText): Record<string, unknown> {
  return (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    output: { score: 0.9, reasoning: 'ok', passed: true, facts: [], next_node: 'w' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    text: Promise.resolve('done'),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    steps: Promise.resolve([]),
  });
});

describe('AgentConfigSchema — maxOutputTokens', () => {
  it('leaves the field absent when not supplied', () => {
    const parsed = AgentConfigSchema.parse({
      id: 'a', name: 'A', model: 'm', provider: 'anthropic', system: 's',
    });

    expect('maxOutputTokens' in parsed).toBe(false);
  });

  it('accepts a positive integer', () => {
    const parsed = AgentConfigSchema.parse({
      id: 'a', name: 'A', model: 'm', provider: 'anthropic', system: 's', maxOutputTokens: 2048,
    });

    expect(parsed.maxOutputTokens).toBe(2048);
  });

  it('rejects a non-positive or fractional value', () => {
    const base = { id: 'a', name: 'A', model: 'm', provider: 'anthropic', system: 's' };

    expect(() => AgentConfigSchema.parse({ ...base, maxOutputTokens: 0 })).toThrow();
    expect(() => AgentConfigSchema.parse({ ...base, maxOutputTokens: -1 })).toThrow();
    expect(() => AgentConfigSchema.parse({ ...base, maxOutputTokens: 1.5 })).toThrow();
  });
});

describe('executeAgent — maxOutputTokens', () => {
  it('passes the configured cap to the provider call', async () => {
    await executeAgent('a-1', stateView(), {}, 1, { agentFactory: factoryWith({ maxOutputTokens: 512 }) });

    expect(callArgs(streamText).maxOutputTokens).toBe(512);
  });

  it('omits the key entirely when unset', async () => {
    await executeAgent('a-1', stateView(), {}, 1, { agentFactory: factoryWith({}) });

    expect('maxOutputTokens' in callArgs(streamText)).toBe(false);
  });
});

describe('evaluateQualityExecutor — maxOutputTokens', () => {
  it('passes the configured cap to the provider call', async () => {
    await evaluateQualityExecutor('a-1', 'goal', 'output', undefined, factoryWith({ maxOutputTokens: 256 }));

    expect(callArgs(generateText).maxOutputTokens).toBe(256);
  });

  it('omits the key entirely when unset', async () => {
    await evaluateQualityExecutor('a-1', 'goal', 'output', undefined, factoryWith({}));

    expect('maxOutputTokens' in callArgs(generateText)).toBe(false);
  });
});

describe('extractFactsExecutor — maxOutputTokens', () => {
  it('passes the configured cap to the provider call', async () => {
    await extractFactsExecutor('a-1', 'some source text', 3, undefined, factoryWith({ maxOutputTokens: 128 }));

    expect(callArgs(generateText).maxOutputTokens).toBe(128);
  });

  it('omits the key entirely when unset', async () => {
    await extractFactsExecutor('a-1', 'some source text', 3, undefined, factoryWith({}));

    expect('maxOutputTokens' in callArgs(generateText)).toBe(false);
  });
});

describe('executeSupervisor — maxOutputTokens', () => {
  it('passes the configured cap to the provider call', async () => {
    await executeSupervisor(supervisorNode(), stateView(), [], 1, {
      agentFactory: factoryWith({ maxOutputTokens: 64 }),
    });

    expect(callArgs(generateText).maxOutputTokens).toBe(64);
  });

  it('omits the key entirely when unset', async () => {
    await executeSupervisor(supervisorNode(), stateView(), [], 1, {
      agentFactory: factoryWith({}),
    });

    expect('maxOutputTokens' in callArgs(generateText)).toBe(false);
  });
});

describe('agent — maxOutputTokens', () => {
  it('carries the cap onto the registry config', () => {
    const value = agent({ model: 'claude-sonnet-4-6', instructions: 'x', maxOutputTokens: 1024 });

    expect(toRegistryConfig(value).maxOutputTokens).toBe(1024);
  });

  it('round-trips the cap through the registry wire form', () => {
    const registry = new InMemoryAgentRegistry();
    const id = registry.register(
      toRegistryConfig(agent({ model: 'claude-sonnet-4-6', instructions: 'x', maxOutputTokens: 1024 })),
    );

    expect(registry.loadAgent(id)).resolves.toMatchObject({ max_output_tokens: 1024 });
  });
});
