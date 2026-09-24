/**
 * Per-tier model selection: modelFor and the env-var tier map.
 */

import { describe, expect, it } from 'vitest';
import { modelFor, tierResolver } from '../src/shared/models.js';
import { maintenanceEnvFromProcess } from '../src/shared/env.js';

describe('modelFor', () => {
  it('resolves a tier from the models map', () => {
    const env = { model: 'claude-sonnet-5', models: { low: 'claude-haiku-4-5' } };

    expect(modelFor(env, 'low')).toBe('claude-haiku-4-5');
  });

  it('falls back to the base model for a missing tier', () => {
    const env = { model: 'claude-sonnet-5', models: { low: 'claude-haiku-4-5' } };

    expect(modelFor(env, 'high')).toBe('claude-sonnet-5');
  });

  it('runs every tier on the base model when no map is set', () => {
    const env = { model: 'qwen2.5:7b' };

    expect(modelFor(env, 'high')).toBe('qwen2.5:7b');
    expect(modelFor(env, 'medium')).toBe('qwen2.5:7b');
    expect(modelFor(env, 'low')).toBe('qwen2.5:7b');
  });
});

describe('tierResolver', () => {
  it('resolves each preference to the tier model modelFor picks', () => {
    const env = {
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      models: { high: 'claude-opus-5-5', low: 'claude-haiku-4-5' },
    };
    const resolve = tierResolver(env);

    expect(resolve('high', 'anthropic', undefined))
      .toEqual({ reason: 'preferred', model: 'claude-opus-5-5', tier: 'high' });
    expect(resolve('medium', 'anthropic', undefined))
      .toEqual({ reason: 'preferred', model: 'claude-sonnet-5', tier: 'medium' });
    expect(resolve('low', 'anthropic', undefined))
      .toEqual({ reason: 'preferred', model: 'claude-haiku-4-5', tier: 'low' });
  });

  it('returns null for a provider outside the env', () => {
    const env = { model: 'claude-sonnet-5', provider: 'anthropic' };

    expect(tierResolver(env)('high', 'openai', undefined)).toBeNull();
  });
});

describe('maintenanceEnvFromProcess', () => {
  it('reads the per-tier model overrides', () => {
    const env = maintenanceEnvFromProcess({
      CYCGRAPH_MODEL: 'claude-sonnet-5',
      CYCGRAPH_MODEL_HIGH: 'claude-opus-5-5',
      CYCGRAPH_MODEL_LOW: 'claude-haiku-4-5',
    });

    expect(env.models).toEqual({ high: 'claude-opus-5-5', low: 'claude-haiku-4-5' });
  });

  it('omits the models map when no tier variable is set', () => {
    const env = maintenanceEnvFromProcess({ CYCGRAPH_MODEL: 'claude-sonnet-5' });

    expect(env.models).toBeUndefined();
  });

  it('treats an empty tier variable as unset', () => {
    const env = maintenanceEnvFromProcess({
      CYCGRAPH_MODEL: 'claude-sonnet-5',
      CYCGRAPH_MODEL_HIGH: '',
      CYCGRAPH_MODEL_MEDIUM: '',
      CYCGRAPH_MODEL_LOW: '',
    });

    expect(env.models).toBeUndefined();
  });

  it('rejects a tier model whose inferred provider differs from the run', () => {
    expect(() => maintenanceEnvFromProcess({
      CYCGRAPH_MODEL: 'claude-sonnet-5',
      CYCGRAPH_MODEL_LOW: 'gpt-5-nano',
    })).toThrow('every tier model must share one provider');
  });

  it('trusts an explicit CYCGRAPH_PROVIDER over tier-model inference', () => {
    const env = maintenanceEnvFromProcess({
      CYCGRAPH_MODEL: 'llama-3.3-70b-versatile',
      CYCGRAPH_MODEL_LOW: 'llama-3.1-8b-instant',
      CYCGRAPH_PROVIDER: 'groq',
    });

    expect(env.provider).toBe('groq');
    expect(env.models).toEqual({ low: 'llama-3.1-8b-instant' });
  });
});
