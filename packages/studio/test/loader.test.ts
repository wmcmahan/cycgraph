/**
 * Tests for ad-hoc scenario loading (src/scenarios/loader.ts): path
 * classification, module lifting, and the bundle wrapper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { agent, bundle, graph, node, tool } from '@cycgraph/orchestrator';
import {
  bundleScenario,
  loadScenarioFile,
  looksLikeScenarioFile,
  ScenarioLoadError,
} from '../src/scenarios/loader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cycgraph-loader-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const echo = () => tool({
  name: 'echo',
  description: 'Echoes.',
  parameters: z.object({}),
  execute: () => ({ said: 'hi' }),
});

describe('looksLikeScenarioFile', () => {
  it('classifies paths and extensions as files', () => {
    expect(looksLikeScenarioFile('./my-graph.ts')).toBe(true);
    expect(looksLikeScenarioFile('graphs/flow.json')).toBe(true);
    expect(looksLikeScenarioFile('flow.mjs')).toBe(true);
  });

  it('leaves registry ids alone', () => {
    expect(looksLikeScenarioFile('smoke-wasteful')).toBe(false);
    expect(looksLikeScenarioFile('improve')).toBe(false);
  });
});

describe('loadScenarioFile', () => {
  it('loads a module whose default export is scenario-shaped', async () => {
    const file = join(dir, 'adhoc.mjs');
    await writeFile(file, [
      'export default {',
      "  id: 'adhoc', title: 'Ad hoc', covers: [], requires: [],",
      '  params: { parse: () => ({}) },',
      '  build: async () => ({}),',
      '};',
    ].join('\n'));

    const scenario = await loadScenarioFile(file);

    expect(scenario.id).toBe('adhoc');
  });

  it('refuses a module without a scenario-shaped export', async () => {
    const file = join(dir, 'not-a-scenario.mjs');
    await writeFile(file, 'export default { id: 42 };');

    await expect(loadScenarioFile(file)).rejects.toThrow(ScenarioLoadError);
  });

  it('refuses malformed bundle json', async () => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{"not": "a bundle"}');

    await expect(loadScenarioFile(file)).rejects.toThrow(ScenarioLoadError);
  });

  it('loads a bundle json file into a runnable scenario shape', async () => {
    const speaker = agent({
      id: 'speaker',
      name: 'Speaker',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      instructions: 'Say something.',
    });
    const inner = graph({
      name: 'echo-flow',
      nodes: [node({ id: 'speak', agent: speaker, writes: 'speech' })],
    });
    const artifact = bundle(inner, { version: '1.0.0' });
    const file = join(dir, 'echo-flow.json');
    await writeFile(file, JSON.stringify(artifact));

    const scenario = await loadScenarioFile(file);

    expect(scenario.id).toBe('echo-flow');
    expect(scenario.covers).toContain('bundle');
  });
});

describe('bundleScenario', () => {
  const agented = () => {
    const speaker = agent({
      id: 'speaker',
      name: 'Speaker',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      instructions: 'Say something.',
    });
    return graph({
      name: 'Speaking Flow',
      nodes: [node({ id: 'speak', agent: speaker, reads: ['topic'], writes: 'speech' })],
    });
  };

  it('wraps the bundle as a one-node subgraph with mapped inputs', async () => {
    const artifact = bundle(agented(), {
      version: '2.0.0',
      description: 'Speaks on a topic',
    });
    artifact.manifest.inputs = {
      topic: { schema: { type: 'string' }, required: true, description: 'What to speak about' },
    };

    const scenario = bundleScenario(artifact, 'speaking.json');
    const params = scenario.params.parse({ topic: 'graphs' }) as Record<string, string>;
    const built = await scenario.build(params as never, {} as never);

    expect(scenario.id).toBe('speaking-flow');
    expect(scenario.requires).toEqual(['model']);
    expect(built.graph.nodes).toHaveLength(1);
    expect(built.graph.nodes[0]!.id).toBe('main');
    expect(built.graph.nodes[0]!.subgraph_config?.input_mapping).toEqual({ topic: 'topic' });
    expect(built.input.memory).toEqual({ topic: 'graphs' });
  });

  it('requires declared required inputs as params', () => {
    const artifact = bundle(agented(), { version: '1.0.0' });
    artifact.manifest.inputs = {
      topic: { schema: { type: 'string' }, required: true },
    };

    const scenario = bundleScenario(artifact, 'speaking.json');

    expect(() => scenario.params.parse({})).toThrow();
  });

  it('refuses a bundle that requires host tools', () => {
    const inner = graph({
      name: 'tooled',
      nodes: [node({ id: 'say', type: 'tool', toolId: 'echo', tools: [echo()] })],
    });
    const artifact = bundle(inner, { version: '1.0.0' });

    expect(() => bundleScenario(artifact, 'tooled.json')).toThrow(/requires host tools \(echo\)/);
  });
});

describe('loadScenarioFile source path', () => {
  it('records where a module scenario came from, so the editor need not search', async () => {
    const file = join(dir, 'sourced.mjs');
    await writeFile(file, [
      'export default {',
      "  id: 'sourced', title: 'Sourced', covers: [], requires: [],",
      '  params: { parse: () => ({}) },',
      '  build: async () => ({}),',
      '};',
    ].join('\n'));

    const scenario = await loadScenarioFile(file);

    expect(scenario.sourcePath).toBe(file);
  });
});
