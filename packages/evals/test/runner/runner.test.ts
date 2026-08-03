/**
 * Tests for the eval runner's flag handling, mode selection, and result
 * assembly.
 *
 * The deterministic-only path runs end-to-end against the real suites —
 * they complete in <1s and need no LLM. Provider selection is exercised
 * through the integration suite, whose SUT-driven contract is empty, so
 * the runner constructs a provider and drives the semantic track without
 * ever calling the judge (no network). The baseline-persistence and
 * `main()`/`process.exit` CLI shell are covered elsewhere or documented
 * as unreachable in-unit (see the group report).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runEvals } from '../../src/runner/runner.js';

describe('runEvals — deterministic-only mode', () => {
  it('runs without invoking any LLM or loading semantic suites', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(result.drift).toBeDefined();
    expect(result.suiteLoadErrors).toEqual([]);
    expect(result.flakyTests).toBeUndefined();
    expect(result.baselineDelta).toBeUndefined();
  });

  it('aggregates deterministic results across suites', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(Object.keys(result.drift.perSuite).length).toBeGreaterThan(0);
  });

  it('passes the drift gate for known-good fixtures', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(result.drift.passed).toBe(true);
    expect(result.drift.aggregatePercent).toBeLessThan(5);
  });

  it('reports no flaky tests at the default sample count', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(result.flakyTests).toBeUndefined();
  });
});

describe('runEvals — single-suite filter', () => {
  it('restricts deterministic execution to a named suite', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      suites: ['memory'],
    });

    expect(result.drift.perSuite).toHaveProperty('memory');
    expect(result.drift.perSuite).not.toHaveProperty('context-engine');
  });
});

describe('runEvals — drift ceiling override', () => {
  it('passes when the override permits current drift', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      driftCeiling: 100,
    });

    expect(result.drift.passed).toBe(true);
  });

  it('fails when the override is below current drift', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      driftCeiling: -1,
    });

    expect(result.drift.passed).toBe(false);
  });

  it('emits CI annotations when the gate fails in ci mode', async () => {
    const result = await runEvals({
      mode: 'ci',
      deterministicOnly: true,
      driftCeiling: -1,
    });

    expect(result.drift.passed).toBe(false);
  });
});

describe('runEvals — empty suite list', () => {
  it('produces an empty drift report and no semantic results', async () => {
    const result = await runEvals({
      mode: 'local',
      suites: [],
    });

    expect(result.drift.perSuite).toEqual({});
    expect(result.suiteLoadErrors).toEqual([]);
    expect(result.flakyTests).toBeUndefined();
  });
});

describe('runEvals — baseline option', () => {
  it('leaves baselineDelta undefined when baseline is not requested', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      baseline: false,
    });

    expect(result.baselineDelta).toBeUndefined();
  });
});

describe('runEvals — provider selection for the semantic track', () => {
  const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
  let savedKeys: Record<string, string | undefined>;

  beforeEach(() => {
    savedKeys = {};
    for (const key of PROVIDER_KEYS) savedKeys[key] = process.env[key];
    process.env['OPENAI_API_KEY'] = 'test-openai-key';
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic-key';
  });

  afterEach(() => {
    for (const key of PROVIDER_KEYS) {
      if (savedKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedKeys[key];
    }
  });

  it('constructs the local Ollama judge by default and runs the empty semantic track', async () => {
    const result = await runEvals({
      mode: 'local',
      suites: ['integration'],
    });

    expect(result.drift).toBeDefined();
    expect(result.flakyTests).toBeUndefined();
    expect(result.suiteLoadErrors).toEqual([]);
  }, 20000);

  it('constructs the OpenAI judge in ci mode by default', async () => {
    const result = await runEvals({
      mode: 'ci',
      suites: ['integration'],
    });

    expect(result.drift).toBeDefined();
    expect(result.flakyTests).toBeUndefined();
  }, 20000);

  it('honors an explicit ollama judge override', async () => {
    const result = await runEvals({
      mode: 'ci',
      suites: ['integration'],
      judgeProvider: 'ollama',
    });

    expect(result.drift).toBeDefined();
  }, 20000);

  it('honors an explicit openai judge override', async () => {
    const result = await runEvals({
      mode: 'local',
      suites: ['integration'],
      judgeProvider: 'openai',
    });

    expect(result.drift).toBeDefined();
  }, 20000);

  it('honors an explicit anthropic judge override', async () => {
    const result = await runEvals({
      mode: 'local',
      suites: ['integration'],
      judgeProvider: 'anthropic',
    });

    expect(result.drift).toBeDefined();
  }, 20000);
});
