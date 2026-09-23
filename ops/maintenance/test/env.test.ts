/**
 * Tests for environment resolution (src/env.ts) — the one place env
 * vars become a MaintenanceEnv.
 */

import { describe, it, expect } from 'vitest';
import { inferProvider, maintenanceEnvFromProcess } from '../src/shared/env.js';
import { defaultMaintenanceContext, type MaintenanceContext } from '../src/shared/context.js';

describe('inferProvider', () => {
  it('maps model prefixes to their providers', () => {
    expect(inferProvider('claude-sonnet-4')).toBe('anthropic');
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('qwen2.5:7b')).toBe('ollama');
  });
});

describe('maintenanceEnvFromProcess', () => {
  it('resolves model, provider, and publish config from env vars', () => {
    const env = maintenanceEnvFromProcess({
      CYCGRAPH_MODEL: 'claude-sonnet-4',
      GH_TOKEN: 'tok',
      GIT_AUTHOR_NAME: 'Bot',
      GIT_AUTHOR_EMAIL: 'bot@x.test',
    });

    expect(env.model).toBe('claude-sonnet-4');
    expect(env.provider).toBe('anthropic');
    expect(env.publish).toEqual({
      token: 'tok',
      identity: { name: 'Bot', email: 'bot@x.test' },
      labels: ['maintenance-managed'],
    });
  });

  it('lets CYCGRAPH_PROVIDER override the inference', () => {
    const env = maintenanceEnvFromProcess({ CYCGRAPH_MODEL: 'mistral:7b', CYCGRAPH_PROVIDER: 'openai' });

    expect(env.provider).toBe('openai');
  });

  it('defaults to the local model, publishing only the managed label', () => {
    const env = maintenanceEnvFromProcess({});

    expect(env.model).toBe('qwen2.5:7b');
    expect(env.provider).toBe('ollama');
    expect(env.publish).toEqual({ labels: ['maintenance-managed'] });
  });

  it('carries this repository\'s default context', () => {
    const env = maintenanceEnvFromProcess({});

    expect(env.context).toEqual(defaultMaintenanceContext());
  });

  it('carries a supplied context in place of the default', () => {
    const context: MaintenanceContext = { ...defaultMaintenanceContext(), branchPrefix: 'bot/' };

    const env = maintenanceEnvFromProcess({}, context);

    expect(env.context).toBe(context);
  });

  it('falls back to the context identity when the environment supplies none', () => {
    const context: MaintenanceContext = { ...defaultMaintenanceContext(), identity: { name: 'Upkeep Bot', email: 'bot@x.test' } };

    const env = maintenanceEnvFromProcess({}, context);

    expect(env.publish?.identity).toEqual({ name: 'Upkeep Bot', email: 'bot@x.test' });
  });

  it('prefers the environment identity over the context identity', () => {
    const context: MaintenanceContext = { ...defaultMaintenanceContext(), identity: { name: 'Context Bot', email: 'ctx@x.test' } };

    const env = maintenanceEnvFromProcess({ GIT_AUTHOR_NAME: 'Env Bot', GIT_AUTHOR_EMAIL: 'env@x.test' }, context);

    expect(env.publish?.identity).toEqual({ name: 'Env Bot', email: 'env@x.test' });
  });
});
