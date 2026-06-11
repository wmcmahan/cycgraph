import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderRegistry } from '../src/agent/provider-registry.js';
import { registerOllamaProvider } from '../src/agent/ollama-provider.js';
import { OLLAMA_MODELS } from '../src/agent/constants.js';
import type { LanguageModel } from 'ai';
import type { OllamaModelFactory } from '../src/agent/ollama-provider.js';

// Mock logger to silence output
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Helper: create a stub LanguageModel. */
function stubModel(id: string): LanguageModel {
  return { provider: 'ollama', modelId: id } as unknown as LanguageModel;
}

/** Helper: create a mock OllamaModelFactory that tracks calls. */
function createMockFactory(): { factory: OllamaModelFactory; calls: Array<{ baseURL: string; modelId: string }> } {
  const calls: Array<{ baseURL: string; modelId: string }> = [];
  const factory: OllamaModelFactory = ({ baseURL }) => (modelId) => {
    calls.push({ baseURL, modelId });
    return stubModel(modelId);
  };
  return { factory, calls };
}

describe('registerOllamaProvider', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    delete process.env.OLLAMA_BASE_URL;
  });

  // ─── Registration ──────────────────────────────────────────────────

  it('registers ollama as a provider', () => {
    const { factory } = createMockFactory();
    registerOllamaProvider(registry, factory);

    expect(registry.has('ollama')).toBe(true);
    expect(registry.listProviders()).toContain('ollama');
  });

  // ─── Model Resolution ─────────────────────────────────────────────

  it('resolves a model via the injected factory', () => {
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory);

    const model = registry.resolveModel('ollama', 'qwen2.5:7b');
    expect(model).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelId).toBe('qwen2.5:7b');
  });

  it('resolves unknown models (warns but does not block)', () => {
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory);

    const model = registry.resolveModel('ollama', 'my-custom-finetune:latest');
    expect(model).toBeDefined();
    expect(calls[0]!.modelId).toBe('my-custom-finetune:latest');
  });

  // ─── Base URL Resolution ──────────────────────────────────────────

  it('uses default base URL when no option or env var is set', () => {
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory);

    registry.resolveModel('ollama', 'qwen2.5:7b');
    expect(calls[0]!.baseURL).toBe('http://localhost:11434');
  });

  it('prefers explicit option over env var', () => {
    process.env.OLLAMA_BASE_URL = 'http://env-host:11434';
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory, { baseUrl: 'http://explicit-host:11434' });

    registry.resolveModel('ollama', 'qwen2.5:7b');
    expect(calls[0]!.baseURL).toBe('http://explicit-host:11434');
  });

  it('uses OLLAMA_BASE_URL env var when no explicit option', () => {
    process.env.OLLAMA_BASE_URL = 'http://remote-host:11434';
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory);

    registry.resolveModel('ollama', 'qwen2.5:7b');
    expect(calls[0]!.baseURL).toBe('http://remote-host:11434');
  });

  it('resolves base URL lazily (at call time, not registration time)', () => {
    const { factory, calls } = createMockFactory();
    registerOllamaProvider(registry, factory);

    // Set env var AFTER registration
    process.env.OLLAMA_BASE_URL = 'http://late-host:11434';

    registry.resolveModel('ollama', 'qwen2.5:7b');
    expect(calls[0]!.baseURL).toBe('http://late-host:11434');
  });

  // ─── Custom Models ────────────────────────────────────────────────

  it('registers default OLLAMA_MODELS', () => {
    const { factory } = createMockFactory();
    registerOllamaProvider(registry, factory);

    for (const model of OLLAMA_MODELS) {
      expect(registry.supportsModel('ollama', model)).toBe(true);
    }
  });

  it('merges custom models with defaults', () => {
    const { factory } = createMockFactory();
    registerOllamaProvider(registry, factory, {
      models: ['my-finetune:v1', 'custom-model:latest'],
    });

    expect(registry.supportsModel('ollama', 'my-finetune:v1')).toBe(true);
    expect(registry.supportsModel('ollama', 'custom-model:latest')).toBe(true);
    // Default models still present
    expect(registry.supportsModel('ollama', 'qwen2.5:7b')).toBe(true);
  });

  // ─── Provider Inference ───────────────────────────────────────────

  it('infers ollama from known model IDs', () => {
    const { factory } = createMockFactory();
    registerOllamaProvider(registry, factory);

    expect(registry.inferProvider('qwen2.5:7b')).toBe('ollama');
    expect(registry.inferProvider('llama3.1:8b')).toBe('ollama');
    expect(registry.inferProvider('mistral:7b')).toBe('ollama');
  });

  // ─── Coexistence ──────────────────────────────────────────────────

  it('coexists with other registered providers', () => {
    // Register a mock OpenAI provider
    registry.register('openai', (id) => stubModel(id), {
      models: ['gpt-4o'],
    });
    registry.register('anthropic', (id) => stubModel(id), {
      models: ['claude-sonnet-4-6'],
    });

    const { factory } = createMockFactory();
    registerOllamaProvider(registry, factory);

    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.has('ollama')).toBe(true);

    // Each provider infers correctly
    expect(registry.inferProvider('gpt-4o')).toBe('openai');
    expect(registry.inferProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(registry.inferProvider('qwen2.5:7b')).toBe('ollama');
  });
});
