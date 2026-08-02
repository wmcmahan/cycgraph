/**
 * Tests for runtime-config: env parsing (envInt) and schema validation
 * (loadRuntimeConfig), both exercised by re-importing the module with
 * controlled env vars.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const CACHE_SIZE_ENV = 'MAX_AGENT_CONFIG_CACHE_SIZE';
const TIMEOUT_ENV = 'AGENT_TIMEOUT_MS';

async function loadWithEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../src/runtime-config.js');
}

describe('runtimeConfig', () => {
  afterEach(() => {
    delete process.env[CACHE_SIZE_ENV];
    delete process.env[TIMEOUT_ENV];
    vi.resetModules();
  });

  it('falls back to schema defaults when no env overrides are set', async () => {
    const mod = await loadWithEnv({ [CACHE_SIZE_ENV]: undefined, [TIMEOUT_ENV]: undefined });

    expect(mod.runtimeConfig.MAX_AGENT_CONFIG_CACHE_SIZE).toBe(100);
    expect(mod.MAX_AGENT_CONFIG_CACHE_SIZE).toBe(100);
  });

  it('applies a valid integer env override', async () => {
    const mod = await loadWithEnv({ [CACHE_SIZE_ENV]: '250' });

    expect(mod.runtimeConfig.MAX_AGENT_CONFIG_CACHE_SIZE).toBe(250);
    expect(mod.MAX_AGENT_CONFIG_CACHE_SIZE).toBe(250);
  });

  it('treats a whitespace-only override as unset and uses the default', async () => {
    const mod = await loadWithEnv({ [CACHE_SIZE_ENV]: '   ' });

    expect(mod.runtimeConfig.MAX_AGENT_CONFIG_CACHE_SIZE).toBe(100);
  });

  it('throws a descriptive error when an override is not a number', async () => {
    await expect(loadWithEnv({ [TIMEOUT_ENV]: '30s' })).rejects.toThrow(
      `env var ${TIMEOUT_ENV}='30s' is not a number`,
    );
  });

  it('throws when an override violates the schema bounds', async () => {
    await expect(loadWithEnv({ [CACHE_SIZE_ENV]: '999999' })).rejects.toThrow(
      /Invalid runtime configuration \(check env vars\)/,
    );
  });

  it('reports the offending field name in a bounds error', async () => {
    await expect(loadWithEnv({ [CACHE_SIZE_ENV]: '0' })).rejects.toThrow(
      /MAX_AGENT_CONFIG_CACHE_SIZE/,
    );
  });
});
