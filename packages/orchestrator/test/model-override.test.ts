/**
 * Budget-aware model override resolution — applies a runner-supplied
 * `model_override` onto a loaded agent config, rejecting blank overrides.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveEffectiveModelConfig } from '../src/agents/models/model-override.js';
import type { AgentConfig } from '../src/agents/types.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system: 'You are helpful.',
    temperature: 0.7,
    maxSteps: 10,
    tools: [],
    read_keys: ['*'],
    write_keys: ['*'],
    ...overrides,
  };
}

describe('resolveEffectiveModelConfig', () => {
  it('replaces the model with a valid override', () => {
    const config = makeConfig();

    const result = resolveEffectiveModelConfig(config, 'claude-opus-4-8', { agentId: 'agent-1' });

    expect(result.model).toBe('claude-opus-4-8');
    expect(result).not.toBe(config);
  });

  it('preserves every other field when overriding the model', () => {
    const config = makeConfig({ system: 'custom prompt', temperature: 0.3 });

    const result = resolveEffectiveModelConfig(config, 'gpt-4o', { agentId: 'agent-1', nodeId: 'n1' });

    expect(result.system).toBe('custom prompt');
    expect(result.temperature).toBe(0.3);
    expect(result.provider).toBe('anthropic');
  });

  it('returns the original config unchanged when no override is provided', () => {
    const config = makeConfig();

    const result = resolveEffectiveModelConfig(config, undefined, { agentId: 'agent-1' });

    expect(result).toBe(config);
  });

  it('keeps the static model when the override is a whitespace-only string', () => {
    const config = makeConfig();

    const result = resolveEffectiveModelConfig(config, '   ', { agentId: 'agent-1', nodeId: 'n1' });

    expect(result).toBe(config);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('keeps the static model when the override is an empty string', () => {
    const config = makeConfig();

    const result = resolveEffectiveModelConfig(config, '', { agentId: 'agent-1' });

    expect(result).toBe(config);
    expect(result.model).toBe('claude-sonnet-4-6');
  });
});
