import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ProviderRegistry,
  registerBuiltInProviders,
  createProviderRegistry,
} from '../src/agent/provider-registry.js';
import { UnsupportedProviderError } from '../src/agent/agent-factory/errors.js';
import type { LanguageModel } from 'ai';

// Mock the AI SDK providers
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => (model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', modelId: model })),
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

/** Helper: create a stub LanguageModel. */
function stubModel(id: string): LanguageModel {
  return { provider: 'stub', modelId: id } as unknown as LanguageModel;
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  // ─── Registration ──────────────────────────────────────────────────

  describe('register / has / listProviders', () => {
    it('registers a provider and reports it via has() and listProviders()', () => {
      registry.register('groq', (id) => stubModel(id), {
        models: ['llama-3-70b'],
      });

      expect(registry.has('groq')).toBe(true);
      expect(registry.listProviders()).toContain('groq');
    });

    it('returns false for unregistered providers', () => {
      expect(registry.has('missing')).toBe(false);
    });

    it('overwrites an existing registration with the same name', () => {
      const first = vi.fn(() => stubModel('a'));
      const second = vi.fn(() => stubModel('b'));

      registry.register('test', first, { models: ['any'] });
      registry.register('test', second, { models: ['any'] });

      registry.resolveModel('test', 'any');
      expect(second).toHaveBeenCalledWith('any');
      expect(first).not.toHaveBeenCalled();
    });
  });

  // ─── Model Resolution ─────────────────────────────────────────────

  describe('resolveModel', () => {
    it('delegates to the registered resolveModel function', () => {
      const resolver = vi.fn((id: string) => stubModel(id));
      registry.register('custom', resolver, { models: ['my-model'] });

      const model = registry.resolveModel('custom', 'my-model');
      expect(resolver).toHaveBeenCalledWith('my-model');
      expect(model).toBeDefined();
    });

    it('throws UnsupportedProviderError for unregistered providers', () => {
      expect(() => registry.resolveModel('nonexistent', 'model'))
        .toThrow(UnsupportedProviderError);
    });

    it('still resolves unknown models (warns but does not block)', () => {
      const resolver = vi.fn((id: string) => stubModel(id));
      registry.register('custom', resolver, { models: ['known-model'] });

      // Should not throw for unknown model
      const model = registry.resolveModel('custom', 'unknown-model');
      expect(model).toBeDefined();
      expect(resolver).toHaveBeenCalledWith('unknown-model');
    });
  });

  // ─── Unregister ────────────────────────────────────────────────────

  describe('unregister', () => {
    it('removes a provider and returns true', () => {
      registry.register('temp', () => stubModel('x'), { models: [] });
      expect(registry.unregister('temp')).toBe(true);
      expect(registry.has('temp')).toBe(false);
    });

    it('returns false when provider does not exist', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  // ─── Exact Match Inference ─────────────────────────────────────────

  describe('inferProvider', () => {
    beforeEach(() => {
      registry.register('openai', () => stubModel('x'), {
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'o1-preview', 'o1-mini', 'o3', 'o3-mini', 'o4-mini'],
      });
      registry.register('anthropic', () => stubModel('x'), {
        models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
      });
    });

    it('infers openai from known gpt model', () => {
      expect(registry.inferProvider('gpt-4-turbo')).toBe('openai');
    });

    it('infers openai from o1-preview', () => {
      expect(registry.inferProvider('o1-preview')).toBe('openai');
    });

    it('infers anthropic from known claude model', () => {
      expect(registry.inferProvider('claude-sonnet-4-6')).toBe('anthropic');
    });

    it('returns default provider for unknown models', () => {
      expect(registry.inferProvider('llama-3-70b')).toBe('anthropic');
    });

    it('returns default provider for models not in the known list (exact match only)', () => {
      expect(registry.inferProvider('gpt-4o-2024-08-06')).toBe('anthropic');
    });

    it('works with custom provider models', () => {
      registry.register('groq', () => stubModel('x'), {
        models: ['llama-3-70b', 'mixtral-8x7b'],
      });
      expect(registry.inferProvider('llama-3-70b')).toBe('groq');
      expect(registry.inferProvider('mixtral-8x7b')).toBe('groq');
    });
  });

  // ─── supportsModel ────────────────────────────────────────────────

  describe('supportsModel', () => {
    beforeEach(() => {
      registry.register('openai', () => stubModel('x'), {
        models: ['gpt-4o', 'gpt-4'],
      });
    });

    it('returns true for a known model', () => {
      expect(registry.supportsModel('openai', 'gpt-4o')).toBe(true);
    });

    it('returns false for an unknown model', () => {
      expect(registry.supportsModel('openai', 'gpt-5')).toBe(false);
    });

    it('returns false for an unregistered provider', () => {
      expect(registry.supportsModel('missing', 'gpt-4o')).toBe(false);
    });
  });

  // ─── addModel ─────────────────────────────────────────────────────

  describe('addModel', () => {
    beforeEach(() => {
      registry.register('openai', () => stubModel('x'), {
        models: ['gpt-4o'],
      });
    });

    it('adds a new model to the provider', () => {
      registry.addModel('openai', 'gpt-5');
      expect(registry.supportsModel('openai', 'gpt-5')).toBe(true);
    });

    it('does not duplicate existing models', () => {
      registry.addModel('openai', 'gpt-4o');
      // inferProvider still works (no duplicate issues)
      expect(registry.inferProvider('gpt-4o')).toBe('openai');
    });

    it('throws UnsupportedProviderError for unregistered provider', () => {
      expect(() => registry.addModel('missing', 'model'))
        .toThrow(UnsupportedProviderError);
    });

    it('makes previously unknown models inferable', () => {
      expect(registry.inferProvider('gpt-5')).toBe('anthropic');
      registry.addModel('openai', 'gpt-5');
      expect(registry.inferProvider('gpt-5')).toBe('openai');
    });
  });
});

// ─── Built-in Providers ─────────────────────────────────────────────

describe('registerBuiltInProviders', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('registers openai and anthropic providers', () => {
    registerBuiltInProviders(registry);
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
  });

  it('resolves models when API keys are set', () => {
    registerBuiltInProviders(registry);
    expect(registry.resolveModel('openai', 'gpt-4')).toBeDefined();
    expect(registry.resolveModel('anthropic', 'claude-sonnet-4-6')).toBeDefined();
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    delete process.env.OPENAI_API_KEY;
    registerBuiltInProviders(registry);
    expect(() => registry.resolveModel('openai', 'gpt-4'))
      .toThrow('OPENAI_API_KEY environment variable is not set');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    registerBuiltInProviders(registry);
    expect(() => registry.resolveModel('anthropic', 'claude-sonnet-4-6'))
      .toThrow('ANTHROPIC_API_KEY environment variable is not set');
  });
});

describe('createProviderRegistry', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns a registry with openai and anthropic pre-registered', () => {
    const registry = createProviderRegistry();
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.listProviders()).toEqual(['openai', 'anthropic']);
  });
});
