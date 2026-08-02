/**
 * AgentConfigSchema — the Zod boundary the factory validates every loaded
 * agent config against.
 */

import { describe, it, expect } from 'vitest';
import { AgentConfigSchema } from '../src/agent/types.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Agent',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system: 'You are helpful.',
    ...overrides,
  };
}

describe('AgentConfigSchema', () => {
  it('applies defaults for temperature, maxSteps, and tools', () => {
    const parsed = AgentConfigSchema.parse(baseConfig());

    expect(parsed.temperature).toBe(0.7);
    expect(parsed.maxSteps).toBe(10);
    expect(parsed.tools).toEqual([]);
  });

  it('validates nested providerOptions of every JSON value kind', () => {
    const parsed = AgentConfigSchema.parse(
      baseConfig({
        providerOptions: {
          anthropic: {
            str: 'text',
            num: 1,
            bool: true,
            nothing: null,
            list: [1, 'two', false, null],
            nested: { deep: { value: 'ok' } },
          },
        },
      }),
    );

    expect(parsed.providerOptions?.anthropic.list).toEqual([1, 'two', false, null]);
    expect(parsed.providerOptions?.anthropic.nested).toEqual({ deep: { value: 'ok' } });
  });

  it('rejects an Anthropic config with temperature above 1', () => {
    expect(() => AgentConfigSchema.parse(baseConfig({ provider: 'anthropic', temperature: 1.5 }))).toThrow(
      /exceeds Anthropic's maximum/,
    );
  });

  it('accepts an Anthropic config at the temperature ceiling of 1', () => {
    const parsed = AgentConfigSchema.parse(baseConfig({ provider: 'anthropic', temperature: 1 }));

    expect(parsed.temperature).toBe(1);
  });

  it('accepts temperature above 1 for non-Anthropic providers', () => {
    const parsed = AgentConfigSchema.parse(baseConfig({ provider: 'openai', temperature: 1.5 }));

    expect(parsed.temperature).toBe(1.5);
  });
});
