/**
 * Ollama Integration Test
 *
 * Validates the full end-to-end flow: registerOllamaProvider → agent config
 * with provider: 'ollama' → model resolution → graph execution.
 *
 * Uses mocked AI SDK (no real Ollama server required).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock AI SDK — intercept streamText to simulate LLM responses
vi.mock('ai', () => ({
  streamText: vi.fn(),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((def: any) => def),
  isStepCount: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

// Mock logger to silence output
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock tracing (no-op)
vi.mock('../src/utils/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: unknown, _name: string, fn: (span: any) => any) =>
    fn({ setAttribute: vi.fn() }),
}));

import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  ProviderRegistry,
  registerBuiltInProviders,
} from '../src/agent/provider-registry.js';
import { registerOllamaProvider } from '../src/agent/ollama-provider.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import {
  agentFactory,
  configureAgentFactory,
  configureProviderRegistry,
} from '../src/agent/agent-factory/index.js';
import { executeAgent } from '../src/agent/agent-executor/executor.js';
import type { StateView } from '../src/types/state.js';

// ─── Helpers ────────────────────────────────────────────────────────

function stubModel(id: string): LanguageModel {
  return { provider: 'ollama', modelId: id } as unknown as LanguageModel;
}

function makeStateView(): StateView {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000001',
    run_id: '00000000-0000-0000-0000-000000000002',
    goal: 'Explain LLMs in simple terms',
    constraints: ['Under 300 words'],
    memory: {},
  };
}

function mockStreamTextResult() {
  const steps = [
    {
      text: 'Here are the research notes...',
      toolCalls: [
        {
          type: 'tool-call' as const,
          toolCallId: 'call-1',
          toolName: 'save_to_memory',
          args: { key: 'research_notes', value: 'LLMs are neural networks trained on text data.' },
        },
      ],
      toolResults: [
        {
          type: 'tool-result' as const,
          toolCallId: 'call-1',
          toolName: 'save_to_memory',
          result: { success: true, key: 'research_notes' },
        },
      ],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
  ];

  return {
    text: Promise.resolve('Here are the research notes...'),
    toolCalls: Promise.resolve(steps[0]!.toolCalls),
    toolResults: Promise.resolve(steps[0]!.toolResults),
    steps: Promise.resolve(steps),
    usage: Promise.resolve({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
    textStream: (async function* () { yield 'Here are the research notes...'; })(),
    fullStream: (async function* () { yield { type: 'finish' }; })(),
    response: Promise.resolve({ id: 'resp-1' }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Ollama integration (end-to-end)', () => {
  let providerRegistry: ProviderRegistry;
  let agentRegistry: InMemoryAgentRegistry;
  let factoryCalls: Array<{ baseURL: string; modelId: string }>;

  beforeEach(() => {
    factoryCalls = [];

    providerRegistry = new ProviderRegistry();
    registerOllamaProvider(
      providerRegistry,
      ({ baseURL }) => (modelId) => {
        factoryCalls.push({ baseURL, modelId });
        return stubModel(modelId);
      },
    );

    agentRegistry = new InMemoryAgentRegistry();

    configureAgentFactory(agentRegistry);
    configureProviderRegistry(providerRegistry);

    vi.mocked(streamText).mockReturnValue(mockStreamTextResult() as any);
  });

  afterEach(() => {
    agentFactory.clearCache();
    vi.restoreAllMocks();
  });

  it('registers an agent with provider: ollama and resolves the model', async () => {
    const agentId = agentRegistry.register({
      name: 'Ollama Research Agent',
      description: 'Research agent on local model',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      system_prompt: 'You are a research specialist.',
      temperature: 0.5,
      max_steps: 3,
      tools: [],
      permissions: {
        read_keys: ['goal'],
        write_keys: ['research_notes'],
      },
    });

    const config = await agentFactory.loadAgent(agentId);
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('qwen2.5:7b');

    const model = agentFactory.getModel(config);
    expect(model).toBeDefined();
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]).toEqual({
      baseURL: 'http://localhost:11434',
      modelId: 'qwen2.5:7b',
    });
  });

  it('executes an agent node using the Ollama provider', async () => {
    const agentId = agentRegistry.register({
      name: 'Ollama Research Agent',
      description: 'Research agent on local model',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      system_prompt: 'You are a research specialist. Save your findings using save_to_memory.',
      temperature: 0.5,
      max_steps: 3,
      tools: [],
      permissions: {
        read_keys: ['goal', 'constraints'],
        write_keys: ['research_notes'],
      },
    });

    const stateView = makeStateView();
    const action = await executeAgent(
      agentId,
      stateView,
      {},
      1,
      { node_id: 'research' },
    );

    expect(action).toBeDefined();
    expect(action.type).toBe('update_memory');
    expect(action.metadata.agent_id).toBe(agentId);
    expect(action.metadata.model).toBe('qwen2.5:7b');

    expect(streamText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(streamText).mock.calls[0]![0] as any;
    expect(call.model).toEqual(stubModel('qwen2.5:7b'));
  });

  it('Ollama provider coexists with built-in providers', async () => {
    registerBuiltInProviders(providerRegistry);

    const ollamaAgentId = agentRegistry.register({
      name: 'Ollama Agent',
      description: 'Local agent',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      system_prompt: 'You are local.',
      temperature: 0.5,
      max_steps: 3,
      tools: [],
      permissions: { read_keys: ['goal'], write_keys: ['output'] },
    });

    const ollamaConfig = await agentFactory.loadAgent(ollamaAgentId);
    const ollamaModel = agentFactory.getModel(ollamaConfig);
    expect(ollamaModel).toBeDefined();
    expect(factoryCalls[0]!.modelId).toBe('qwen2.5:7b');

    expect(providerRegistry.has('ollama')).toBe(true);
    expect(providerRegistry.has('openai')).toBe(true);
    expect(providerRegistry.has('anthropic')).toBe(true);
  });

  it('uses custom base URL from options', async () => {
    providerRegistry = new ProviderRegistry();
    registerOllamaProvider(
      providerRegistry,
      ({ baseURL }) => (modelId) => {
        factoryCalls.push({ baseURL, modelId });
        return stubModel(modelId);
      },
      { baseUrl: 'http://gpu-server:11434' },
    );
    configureProviderRegistry(providerRegistry);

    const agentId = agentRegistry.register({
      name: 'Remote Ollama Agent',
      description: 'Agent on remote Ollama',
      model: 'llama3.1:70b',
      provider: 'ollama',
      system_prompt: 'You are a remote agent.',
      temperature: 0.3,
      max_steps: 3,
      tools: [],
      permissions: { read_keys: ['goal'], write_keys: ['output'] },
    });

    const config = await agentFactory.loadAgent(agentId);
    agentFactory.getModel(config);

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]!.baseURL).toBe('http://gpu-server:11434');
    expect(factoryCalls[0]!.modelId).toBe('llama3.1:70b');
  });
});
