/**
 * Per-tier model selection: modelFor and the env-var tier map.
 */

import { describe, expect, it } from 'vitest';
import { modelFor } from '../src/shared/models.js';
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
});
