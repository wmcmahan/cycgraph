/**
 * Tests for the Google Gemini provider registration helper.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderRegistry } from '../src/agents/providers/provider-registry.js';
import { registerGoogleProvider } from '../src/agents/providers/google-provider.js';
import { GOOGLE_MODELS } from '../src/agents/constants.js';
import type { LanguageModel } from 'ai';
import type { GoogleModelFactory } from '../src/agents/providers/google-provider.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function stubModel(id: string): LanguageModel {
  return { modelId: id } as unknown as LanguageModel;
}

function createMockFactory(): {
  factory: GoogleModelFactory;
  calls: Array<{ apiKey: string; modelId: string }>;
} {
  const calls: Array<{ apiKey: string; modelId: string }> = [];
  const factory: GoogleModelFactory = ({ apiKey }) => (modelId) => {
    calls.push({ apiKey, modelId });
    return stubModel(modelId);
  };
  return { factory, calls };
}

describe('registerGoogleProvider', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('registers google as a provider', () => {
    const { factory } = createMockFactory();
    registerGoogleProvider(registry, factory);

    expect(registry.has('google')).toBe(true);
  });

  it('resolves a model via the injected factory', () => {
    const { factory, calls } = createMockFactory();
    registerGoogleProvider(registry, factory);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-key';

    const model = registry.resolveModel('google', 'gemini-3.8-flash');

    expect(model).toBeDefined();
    expect(calls).toEqual([{ apiKey: 'g-key', modelId: 'gemini-3.8-flash' }]);
  });

  it('falls back to GEMINI_API_KEY when the SDK env var is unset', () => {
    const { factory, calls } = createMockFactory();
    registerGoogleProvider(registry, factory);
    process.env.GEMINI_API_KEY = 'gemini-key';

    registry.resolveModel('google', 'gemini-3.1-pro-preview');

    expect(calls[0]!.apiKey).toBe('gemini-key');
  });

  it('throws when neither API key env var is set', () => {
    const { factory } = createMockFactory();
    registerGoogleProvider(registry, factory);

    expect(() => registry.resolveModel('google', 'gemini-3.8-flash'))
      .toThrow('GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set');
  });

  it('rejects a model outside the known list', () => {
    const { factory } = createMockFactory();
    registerGoogleProvider(registry, factory);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-key';

    expect(() => registry.resolveModel('google', 'gemini-9-ultra')).toThrow('Unknown model');
  });

  it('accepts additional models from options', () => {
    const { factory, calls } = createMockFactory();
    registerGoogleProvider(registry, factory, { models: ['gemini-exp-tuned'] });
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-key';

    registry.resolveModel('google', 'gemini-exp-tuned');

    expect(calls[0]!.modelId).toBe('gemini-exp-tuned');
  });

  it('infers the provider from a known gemini model id', () => {
    const { factory } = createMockFactory();
    registerGoogleProvider(registry, factory);

    expect(registry.inferProvider('gemini-3.8-flash')).toBe('google');
  });

  it('does not resolve the API key at registration time', () => {
    const { factory } = createMockFactory();

    expect(() => registerGoogleProvider(registry, factory)).not.toThrow();
  });

  it('registers every model in the built-in list', () => {
    const { factory } = createMockFactory();
    registerGoogleProvider(registry, factory);

    for (const model of GOOGLE_MODELS) {
      expect(registry.supportsModel('google', model)).toBe(true);
    }
  });
});
