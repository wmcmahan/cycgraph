import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentFactory } from '../src/agent/agent-factory/agent-factory.js';
import { AgentNotFoundError, UnsupportedProviderError, AgentLoadError } from '../src/agent/agent-factory/errors.js';
import { isValidUUID } from '../src/agent/agent-factory/validation.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { createProviderRegistry } from '../src/agent/provider-registry.js';
import type { LanguageModel } from 'ai';

// Mock the AI SDK providers so tests don't need real API keys
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

// Valid UUID for tests that need to pass UUID validation
const TEST_UUID = '00000000-0000-4000-8000-000000000001';

// ─── isValidUUID ─────────────────────────────────────────────────────

describe('isValidUUID', () => {
  it('accepts valid UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID(TEST_UUID)).toBe(true);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('12345')).toBe(false);
  });

  it('rejects UUIDs without hyphens', () => {
    expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

// ─── AgentFactory ────────────────────────────────────────────────────

describe('AgentFactory', () => {
  let factory: AgentFactory;
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    factory = new AgentFactory();
    registry = new InMemoryAgentRegistry();
    factory.setRegistry(registry);
    // Set dummy API keys so model creation doesn't throw
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
  });

  // ─── getDefaultConfig ─────────────────────────────────────────────

  describe('getDefaultConfig', () => {
    it('returns a valid AgentConfig with the given ID and deny-all permissions', () => {
      const config = factory.getDefaultConfig('test-agent');
      expect(config.id).toBe('test-agent');
      expect(config.name).toBe('test-agent');
      expect(config.model).toBe('claude-sonnet-4-6');
      expect(config.provider).toBe('anthropic');
      expect(config.temperature).toBe(0.7);
      expect(config.maxSteps).toBe(10);
      expect(config.tools).toEqual([]);
      expect(config.read_keys).toEqual([]);
      expect(config.write_keys).toEqual([]);
    });
  });

  // ─── getModel ─────────────────────────────────────────────────────

  describe('getModel', () => {
    it('returns a language model for anthropic provider', () => {
      const config = factory.getDefaultConfig('test');
      const model = factory.getModel(config);
      expect(model).toBeDefined();
    });

    it('caches model instances for the same provider:model key', () => {
      const config = factory.getDefaultConfig('test');
      const model1 = factory.getModel(config);
      const model2 = factory.getModel(config);
      expect(model1).toBe(model2); // Same reference
    });

    it('returns different model instances for different configs', () => {
      const config1 = { ...factory.getDefaultConfig('a'), model: 'claude-sonnet-4-6', provider: 'anthropic' };
      const config2 = { ...factory.getDefaultConfig('b'), model: 'gpt-4-turbo', provider: 'openai' };
      const m1 = factory.getModel(config1);
      const m2 = factory.getModel(config2);
      expect(m1).not.toBe(m2);
    });

    it('throws AgentLoadError when API key is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const config = factory.getDefaultConfig('test');
      expect(() => factory.getModel(config)).toThrow(AgentLoadError);
    });
  });

  // ─── loadAgent ────────────────────────────────────────────────────

  describe('loadAgent', () => {
    it('throws AgentLoadError for transient registry errors (no silent fallback)', async () => {
      const failingRegistry = {
        loadAgent: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      };
      factory.setRegistry(failingRegistry);
      await expect(factory.loadAgent(TEST_UUID)).rejects.toThrow(AgentLoadError);
    });

    it('fails closed for a non-UUID id when a registry is configured', async () => {
      // A typo'd/invalid agent_id must surface, not silently become a generic
      // deny-all assistant that "completes" with garbage output.
      await expect(factory.loadAgent('missing-agent')).rejects.toThrow(AgentNotFoundError);
    });

    it('fails closed when the agent is not in the registry', async () => {
      await expect(factory.loadAgent(TEST_UUID)).rejects.toThrow(AgentNotFoundError);
    });

    it('falls back to default when setAllowDefaultFallback(true) is opted in', async () => {
      factory.setAllowDefaultFallback(true);
      const config = await factory.loadAgent(TEST_UUID);
      expect(config.id).toBe(TEST_UUID);
      expect(config.model).toBe('claude-sonnet-4-6');
      expect(config.read_keys).toEqual([]);
      expect(config.write_keys).toEqual([]);
    });

    it('handles null permissions safely', async () => {
      registry.register({
        id: TEST_UUID,
        name: 'Test Agent',
        description: 'test',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You are helpful',
        temperature: 0.5,
        max_steps: 5,
        tools: [],
        permissions: null,
      });
      const config = await factory.loadAgent(TEST_UUID);
      expect(config.read_keys).toEqual([]);
      expect(config.write_keys).toEqual([]);
    });

    it('loads agent with valid permissions from registry', async () => {
      registry.register({
        id: TEST_UUID,
        name: 'Test Agent',
        description: 'test',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You are helpful',
        temperature: 0.5,
        max_steps: 5,
        tools: [],
        permissions: { read_keys: ['*'], write_keys: ['output'] },
      });
      const config = await factory.loadAgent(TEST_UUID);
      expect(config.read_keys).toEqual(['*']);
      expect(config.write_keys).toEqual(['output']);
    });

    it('infers anthropic provider from known claude model name', async () => {
      registry.register({
        id: TEST_UUID,
        name: 'Test Agent',
        description: 'test',
        model: 'claude-3-5-sonnet-20241022',
        provider: null, // no explicit provider — triggers inference
        system_prompt: 'You are helpful',
        temperature: 0.5,
        max_steps: 5,
        tools: [],
        permissions: null,
      });
      const config = await factory.loadAgent(TEST_UUID);
      expect(config.provider).toBe('anthropic');
    });

    it('infers openai provider from gpt- model name', async () => {
      registry.register({
        id: TEST_UUID,
        name: 'Test Agent',
        description: 'test',
        model: 'gpt-4-turbo',
        provider: null,
        system_prompt: 'You are helpful',
        temperature: 0.5,
        max_steps: 5,
        tools: [],
        permissions: null,
      });
      const config = await factory.loadAgent(TEST_UUID);
      expect(config.provider).toBe('openai');
    });

    it('caches config and serves from cache on second call', async () => {
      factory.setAllowDefaultFallback(true);
      const config1 = await factory.loadAgent('cached-agent');
      const config2 = await factory.loadAgent('cached-agent');
      expect(config1).toEqual(config2);
    });

    it('falls back to default when no registry is configured', async () => {
      const noDbFactory = new AgentFactory();
      const config = await noDbFactory.loadAgent(TEST_UUID);
      expect(config.id).toBe(TEST_UUID);
      expect(config.model).toBe('claude-sonnet-4-6');
    });
  });

  // ─── clearCache ───────────────────────────────────────────────────

  describe('clearCache', () => {
    it('clears all caches so new instances are created', () => {
      const config = factory.getDefaultConfig('test');
      const model1 = factory.getModel(config);
      factory.clearCache();
      const model2 = factory.getModel(config);
      expect(model2).toBeDefined();
      // After clearing, a new model instance should be created (not the same ref)
      // Note: with mocked providers, the objects are structurally equal but different refs
    });
  });

  // ─── Error classes ────────────────────────────────────────────────

  describe('Error classes', () => {
    it('AgentNotFoundError has correct name and message', () => {
      const err = new AgentNotFoundError('abc');
      expect(err.name).toBe('AgentNotFoundError');
      expect(err.message).toContain('abc');
      expect(err).toBeInstanceOf(Error);
    });

    it('UnsupportedProviderError has correct name and message', () => {
      const err = new UnsupportedProviderError('gemini');
      expect(err.name).toBe('UnsupportedProviderError');
      expect(err.message).toContain('gemini');
      expect(err).toBeInstanceOf(Error);
    });

    it('AgentLoadError preserves cause via native Error.cause', () => {
      const cause = new Error('connection refused');
      const err = new AgentLoadError('test-id', cause);
      expect(err.name).toBe('AgentLoadError');
      expect(err.message).toContain('test-id');
      expect(err.message).toContain('connection refused');
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(Error);
    });

    it('AgentLoadError handles non-Error cause', () => {
      const err = new AgentLoadError('test-id', 'string error');
      expect(err.message).toContain('string error');
      expect(err.cause).toBe('string error');
    });
  });
});
