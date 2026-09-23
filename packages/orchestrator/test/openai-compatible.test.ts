/**
 * Tests for the OpenAI-compatible provider catalog and registration helper.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderRegistry } from '../src/agents/providers/provider-registry.js';
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  registerOpenAICompatibleProviders,
} from '../src/agents/providers/openai-compatible.js';
import { CEREBRAS_MODELS, DEEPSEEK_API_MODELS, GROQ_MODELS, MISTRAL_MODELS, XAI_MODELS } from '../src/agents/constants.js';
import type { LanguageModel } from 'ai';
import type { OpenAICompatibleModelFactory } from '../src/agents/providers/openai-compatible.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const KEY_ENVS = [
  'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY',
];

function stubModel(id: string): LanguageModel {
  return { modelId: id } as unknown as LanguageModel;
}

function createMockFactory(): {
  factory: OpenAICompatibleModelFactory;
  calls: Array<{ name: string; baseURL: string; apiKey: string; modelId: string }>;
} {
  const calls: Array<{ name: string; baseURL: string; apiKey: string; modelId: string }> = [];
  const factory: OpenAICompatibleModelFactory = ({ name, baseURL, apiKey }) => (modelId) => {
    calls.push({ name, baseURL, apiKey, modelId });
    return stubModel(modelId);
  };
  return { factory, calls };
}

describe('registerOpenAICompatibleProviders', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
    for (const env of KEY_ENVS) process.env[env] = 'test-key';
  });

  afterEach(() => {
    for (const env of KEY_ENVS) delete process.env[env];
  });

  it('registers the whole catalog by default', () => {
    const { factory } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    expect(registry.listProviders().sort()).toEqual([
      'cerebras', 'deepseek', 'fireworks', 'groq', 'mistral', 'openrouter', 'together', 'xai',
    ]);
  });

  it('registers only the requested subset', () => {
    const { factory } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory, { providers: ['groq'] });

    expect(registry.listProviders()).toEqual(['groq']);
  });

  it('rejects a subset name that matches no catalog entry', () => {
    const { factory } = createMockFactory();

    expect(() => registerOpenAICompatibleProviders(registry, factory, { providers: ['grok'] }))
      .toThrow('Unknown OpenAI-compatible provider "grok"');
  });

  it('resolves a model via the injected factory with the spec endpoint and key', () => {
    const { factory, calls } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    const model = registry.resolveModel('groq', 'llama-3.3-70b-versatile');

    expect(model).toBeDefined();
    expect(calls).toEqual([{
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'test-key',
      modelId: 'llama-3.3-70b-versatile',
    }]);
  });

  it('throws when the provider API key env var is not set', () => {
    const { factory } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);
    delete process.env.XAI_API_KEY;

    expect(() => registry.resolveModel('xai', 'grok-4.7'))
      .toThrow('XAI_API_KEY environment variable is not set');
  });

  it('rejects an unknown model on a curated provider', () => {
    const { factory } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    expect(() => registry.resolveModel('deepseek', 'deepseek-v9')).toThrow('Unknown model');
  });

  it('passes arbitrary slugs through on openrouter', () => {
    const { factory, calls } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    const model = registry.resolveModel('openrouter', 'meta-llama/llama-4-maverick');

    expect(model).toBeDefined();
    expect(calls[0]!.modelId).toBe('meta-llama/llama-4-maverick');
  });

  it('passes an unlisted model through on groq', () => {
    const { factory, calls } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    registry.resolveModel('groq', 'qwen/qwen3-235b');

    expect(calls[0]!.modelId).toBe('qwen/qwen3-235b');
  });

  it('registers extra endpoints alongside the catalog', () => {
    const { factory, calls } = createMockFactory();
    process.env.CORP_GATEWAY_API_KEY = 'gw-key';
    registerOpenAICompatibleProviders(registry, factory, {
      extra: [{
        name: 'corp-gateway',
        baseURL: 'https://llm.corp.internal/v1',
        apiKeyEnv: 'CORP_GATEWAY_API_KEY',
        models: ['internal-model-1'],
      }],
    });

    registry.resolveModel('corp-gateway', 'internal-model-1');

    expect(calls[0]).toEqual({
      name: 'corp-gateway',
      baseURL: 'https://llm.corp.internal/v1',
      apiKey: 'gw-key',
      modelId: 'internal-model-1',
    });
    delete process.env.CORP_GATEWAY_API_KEY;
  });

  it('lets an extra spec replace a catalog entry of the same name', () => {
    const { factory, calls } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory, {
      extra: [{
        name: 'groq',
        baseURL: 'https://gateway.internal/groq/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        models: ['llama-3.3-70b-versatile'],
      }],
    });

    registry.resolveModel('groq', 'llama-3.3-70b-versatile');

    expect(calls[0]!.baseURL).toBe('https://gateway.internal/groq/v1');
  });

  it('infers the provider from a known model id', () => {
    const { factory } = createMockFactory();
    registerOpenAICompatibleProviders(registry, factory);

    expect(registry.inferProvider('grok-4.7')).toBe('xai');
    expect(registry.inferProvider('deepseek-v4-pro')).toBe('deepseek');
    expect(registry.inferProvider('openai/gpt-oss-120b')).toBe('groq');
    expect(registry.inferProvider('mistral-medium-latest')).toBe('mistral');
    expect(registry.inferProvider('qwen-3.8-27b')).toBe('cerebras');
  });

  it('does not resolve API keys at registration time', () => {
    for (const env of KEY_ENVS) delete process.env[env];
    const { factory } = createMockFactory();

    expect(() => registerOpenAICompatibleProviders(registry, factory)).not.toThrow();
  });
});

describe('OPENAI_COMPATIBLE_PROVIDERS', () => {
  it('carries the known model lists from constants', () => {
    const byName = new Map(OPENAI_COMPATIBLE_PROVIDERS.map((spec) => [spec.name, spec]));

    expect(byName.get('groq')?.models).toEqual(GROQ_MODELS);
    expect(byName.get('deepseek')?.models).toEqual(DEEPSEEK_API_MODELS);
    expect(byName.get('xai')?.models).toEqual(XAI_MODELS);
    expect(byName.get('mistral')?.models).toEqual(MISTRAL_MODELS);
    expect(byName.get('cerebras')?.models).toEqual(CEREBRAS_MODELS);
    expect(byName.get('openrouter')?.models).toEqual([]);
    expect(byName.get('together')?.models).toEqual([]);
    expect(byName.get('fireworks')?.models).toEqual([]);
  });

  it('fails fast on unknown models only for the fixed-catalog labs', () => {
    const strict = OPENAI_COMPATIBLE_PROVIDERS
      .filter((spec) => spec.allowUnknownModels !== true)
      .map((spec) => spec.name)
      .sort();

    expect(strict).toEqual(['deepseek', 'xai']);
  });
});
