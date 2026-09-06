/**
 * Tests for environment resolution (src/env.ts) — the one place env
 * vars become a MaintenanceEnv.
 */

import { describe, it, expect } from 'vitest';
import { inferProvider, maintenanceEnvFromProcess } from '../src/env.js';

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
    expect(env.publish).toEqual({ token: 'tok', identity: { name: 'Bot', email: 'bot@x.test' } });
  });

  it('lets CYCGRAPH_PROVIDER override the inference', () => {
    const env = maintenanceEnvFromProcess({ CYCGRAPH_MODEL: 'mistral:7b', CYCGRAPH_PROVIDER: 'openai' });

    expect(env.provider).toBe('openai');
  });

  it('defaults to the local model with an empty publish config', () => {
    const env = maintenanceEnvFromProcess({});

    expect(env.model).toBe('qwen2.5:7b');
    expect(env.provider).toBe('ollama');
    expect(env.publish).toEqual({});
  });
});
