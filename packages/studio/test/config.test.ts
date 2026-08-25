/**
 * Tests for cycgraph.config loading (src/config.ts): discovery, validation,
 * catalog building, and the stack defaults a config implies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  catalogFromConfig,
  loadStudioConfig,
  stackDefaultsFrom,
  StudioConfigError,
} from '../src/config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cycgraph-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadStudioConfig', () => {
  it('returns undefined when no config exists', async () => {
    expect(await loadStudioConfig(dir)).toBeUndefined();
  });

  it('loads a json config with its directory', async () => {
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({
      graphs: ['./graphs/flow.ts'],
      model: 'claude-sonnet-4-5',
    }));

    const loaded = await loadStudioConfig(dir);

    expect(loaded?.config.graphs).toEqual(['./graphs/flow.ts']);
    expect(loaded?.config.model).toBe('claude-sonnet-4-5');
    expect(loaded?.dir).toBe(dir);
  });

  it('loads a module config through its default export', async () => {
    await writeFile(join(dir, 'cycgraph.config.mjs'),
      "export default { graphs: [], tenant: 'acme' };\n");

    const loaded = await loadStudioConfig(dir);

    expect(loaded?.config.tenant).toBe('acme');
  });

  it('prefers the module form when both exist', async () => {
    await writeFile(join(dir, 'cycgraph.config.mjs'), "export default { tenant: 'module' };\n");
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({ tenant: 'json' }));

    const loaded = await loadStudioConfig(dir);

    expect(loaded?.config.tenant).toBe('module');
  });

  it('rejects a config that fails the schema, naming the field', async () => {
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({ graphs: 'not-a-list' }));

    await expect(loadStudioConfig(dir)).rejects.toThrow(StudioConfigError);
    await expect(loadStudioConfig(dir)).rejects.toThrow(/graphs/);
  });

  it('rejects a module config that throws on import', async () => {
    await writeFile(join(dir, 'cycgraph.config.mjs'), "throw new Error('boom');\n");

    await expect(loadStudioConfig(dir)).rejects.toThrow(StudioConfigError);
  });
});

describe('catalogFromConfig', () => {
  it('loads declared graphs relative to the config directory', async () => {
    await writeFile(join(dir, 'flow.mjs'), [
      'export default {',
      "  id: 'my-flow', title: 'My flow', covers: [], requires: [],",
      '  params: { parse: () => ({}) },',
      '  build: async () => ({}),',
      '};',
    ].join('\n'));
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({ graphs: ['./flow.mjs'] }));

    const loaded = await loadStudioConfig(dir);
    const catalog = await catalogFromConfig(loaded!);

    expect(catalog.scenarios.map((s) => s.id)).toEqual(['my-flow']);
    expect(catalog.find('my-flow')).toBeDefined();
  });
});

describe('database field', () => {
  it('parses a connection string declaration', async () => {
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({
      database: 'postgresql://app:secret@db.internal:5432/flows',
    }));

    const loaded = await loadStudioConfig(dir);

    expect(loaded?.config.database).toBe('postgresql://app:secret@db.internal:5432/flows');
  });
});

describe('stackDefaultsFrom', () => {
  it('maps declared settings and resolves paths against the config dir', async () => {
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({
      model: 'qwen2.5:7b',
      artifactRoot: './.cycgraph',
      repo: '.',
      jaeger: false,
    }));

    const loaded = await loadStudioConfig(dir);
    const defaults = stackDefaultsFrom(loaded!);

    expect(defaults).toEqual({
      model: 'qwen2.5:7b',
      artifactRoot: resolve(dir, '.cycgraph'),
      applyRepo: resolve(dir, '.'),
      jaeger: false,
    });
  });

  it('implies nothing a config does not declare', async () => {
    await writeFile(join(dir, 'cycgraph.config.json'), JSON.stringify({}));

    const loaded = await loadStudioConfig(dir);

    expect(stackDefaultsFrom(loaded!)).toEqual({});
  });
});
