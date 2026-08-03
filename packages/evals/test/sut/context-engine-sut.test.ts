/**
 * Unit tests for the context-engine SUT.
 *
 * Runs known trajectories through the dispatch + library calls to verify
 * the wrapper produces sensible output for each supported category.
 */

import { describe, it, expect } from 'vitest';
import {
  runContextEngineSut,
  getSupportedContextEngineHandlers,
  isContextEngineTrajectorySupported,
} from '../../src/sut/context-engine-sut.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

function makeTrajectory(
  tags: string[],
  input: string,
  overrides: Partial<GoldenTrajectory> = {},
): GoldenTrajectory {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    suite: 'context-engine',
    description: 'test',
    input,
    expectedOutput: '',
    tags,
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('runContextEngineSut — format', () => {
  it('serializes tabular data to a compact form', async () => {
    const tabular = JSON.stringify([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ]);

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['format', 'json'], tabular),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      compressed: string;
      input_tokens: number;
      output_tokens: number;
    };
    expect(parsed.compressed).toContain('Alice');
    expect(parsed.output_tokens).toBeLessThanOrEqual(parsed.input_tokens);
  });
});

describe('runContextEngineSut — dedup', () => {
  it('removes exact duplicates', async () => {
    const input = [
      'Multi-agent systems cost 5-10x more.',
      'Local deployment is better.',
      'Multi-agent systems cost 5-10x more.',
    ].join('\n');

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['dedup', 'exact'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      kept_count: number;
      removed: number;
    };
    expect(parsed.kept_count).toBe(2);
    expect(parsed.removed).toBe(1);
  });

  it('detects fuzzy near-duplicates at 0.8 threshold', async () => {
    const input = [
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments today',
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments now',
    ].join('\n');

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['dedup', 'fuzzy'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { removed: number };
    expect(parsed.removed).toBe(1);
  });

  it('routes fuzzy-tagged trajectories to the fuzzy handler before exact', async () => {
    const input = ['a near match string', 'a near match string!'].join('\n');

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['dedup', 'exact', 'fuzzy'], input),
    });

    expect(result.status).toBe('completed');
    expect(result.finalMemory.handler).toBe('fuzzy-dedup');
  });
});

describe('runContextEngineSut — budget', () => {
  it('allocates tokens within budget across segments', async () => {
    const input = JSON.stringify({
      system: 'You are a helpful assistant.',
      memory: 'x'.repeat(800),
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['priority', 'budget'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      total_allocated: number;
      max_available: number;
      allocations: Record<string, number>;
    };
    expect(parsed.total_allocated).toBeLessThanOrEqual(parsed.max_available);
    expect(parsed.allocations).toHaveProperty('system');
  });

  it('roles a tools segment as locked and serializes non-string values', async () => {
    const input = JSON.stringify({
      tools: 'search(query)',
      locked: 'pinned context',
      memory: { note: 'structured value' },
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['priority', 'budget'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      allocations: Record<string, number>;
      total_allocated: number;
    };
    expect(typeof parsed.total_allocated).toBe('number');
    expect(parsed.allocations).toHaveProperty('tools');
  });
});

describe('runContextEngineSut — incremental cache', () => {
  it('reports fresh+cached counts across two turns of identical content', async () => {
    const input = JSON.stringify({
      turn1: '{"name": "Alice"}',
      turn2: '{"name": "Alice"}',
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['incremental', 'cache'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn1: { fresh: number; cached: number };
      turn2: { fresh: number; cached: number };
    };
    expect(parsed.turn1.fresh).toBe(1);
    expect(parsed.turn1.cached).toBe(0);
    expect(parsed.turn2.cached).toBe(1);
  });

  it('recompresses on changed content', async () => {
    const input = JSON.stringify({
      turn1: 'initial context',
      turn2: 'completely different content',
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['incremental', 'cache'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn2: { fresh: number; cached: number };
    };
    expect(parsed.turn2.fresh).toBe(1);
    expect(parsed.turn2.cached).toBe(0);
  });

  it('defaults non-string turn values to empty strings', async () => {
    const input = JSON.stringify({ turn1: 123, turn2: false });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['incremental', 'cache'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn1: { fresh: number };
      turn2: { cached: number };
    };
    expect(parsed.turn1.fresh).toBe(1);
    expect(parsed.turn2.cached).toBe(1);
  });

  it('falls back to a blank-line split when the input is not a JSON object', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['incremental', 'cache'], 'first turn\n\nsecond turn'),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn1: { fresh: number };
      turn2: { fresh: number };
    };
    expect(parsed.turn1.fresh).toBe(1);
    expect(parsed.turn2.fresh).toBe(1);
  });

  it('reuses the sole segment for turn2 when a non-JSON input has no blank line', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['incremental', 'cache'], 'only one turn'),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn2: { cached: number };
    };
    expect(parsed.turn2.cached).toBe(1);
  });
});

describe('runContextEngineSut — adaptive memory', () => {
  it('handles an empty memory payload', async () => {
    const input = JSON.stringify({ themes: [], facts: [], episodes: [] });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory', 'adaptive'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      contains_themes: boolean;
      contains_facts: boolean;
    };
    expect(parsed.contains_themes).toBe(false);
    expect(parsed.contains_facts).toBe(false);
  });

  it('processes a populated memory payload without throwing', async () => {
    const input = JSON.stringify({
      themes: [{ id: 't1', label: 'Architecture', fact_ids: ['f1'] }],
      facts: [{
        id: 'f1',
        content: 'Uses graph engine',
        source_episode_ids: [],
        entity_ids: [],
        theme_id: 't1',
        valid_from: '2026-01-15',
      }],
      episodes: [],
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory', 'adaptive'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { contains_facts: boolean };
    expect(parsed.contains_facts).toBe(true);
  });

  it('routes a bare memory tag to the adaptive handler', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory'], JSON.stringify({ themes: [], facts: [], episodes: [] })),
    });

    expect(result.status).toBe('completed');
    expect(result.finalMemory.handler).toBe('adaptive-memory');
  });

  it('coerces malformed fact fields to safe defaults', async () => {
    const input = JSON.stringify({
      themes: 'not-an-array',
      facts: [{ valid_until: '2027-01-01' }],
      episodes: 'not-an-array',
    });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory', 'adaptive'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      contains_themes: boolean;
      contains_facts: boolean;
    };
    expect(parsed.contains_themes).toBe(false);
    expect(parsed.contains_facts).toBe(true);
  });

  it('treats a non-array facts field as an empty fact list', async () => {
    const input = JSON.stringify({ themes: [{ id: 't1', label: 'x', fact_ids: [] }], facts: 'nope' });

    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory', 'adaptive'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { contains_facts: boolean };
    expect(parsed.contains_facts).toBe(false);
  });

  it('defaults to an empty payload when the input is not a JSON object', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['memory', 'adaptive'], 'plain text payload'),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      contains_themes: boolean;
      contains_facts: boolean;
    };
    expect(parsed.contains_themes).toBe(false);
    expect(parsed.contains_facts).toBe(false);
  });
});

describe('runContextEngineSut — pipeline', () => {
  it('runs the full balanced preset and reports stage names', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(
        ['pipeline', 'multi-stage'],
        'Complex content that exercises all stages of the balanced preset.',
      ),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      stages: string[];
      stage_count: number;
      input_tokens: number;
      output_tokens: number;
    };
    expect(parsed.stage_count).toBeGreaterThanOrEqual(6);
    expect(parsed.input_tokens).toBeGreaterThan(0);
    expect(parsed.output_tokens).toBeLessThanOrEqual(parsed.input_tokens);
  });

  it('reports zero reduction when the input has no tokens', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['pipeline', 'multi-stage'], ''),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      input_tokens: number;
      reduction_percent: number;
    };
    expect(parsed.input_tokens).toBe(0);
    expect(parsed.reduction_percent).toBe(0);
  });
});

describe('runContextEngineSut — unsupported tags', () => {
  it('returns a failed status for genuinely unknown tags', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['some-future-feature'], '{}'),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No context-engine handler');
  });

  it('reports failure for empty tags', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory([], '{}'),
    });

    expect(result.status).toBe('failed');
  });

  it('reports failure when the tags array is absent', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(undefined as unknown as string[], '{}'),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No context-engine handler');
  });
});

describe('runContextEngineSut — error path', () => {
  it('surfaces JSON parse errors as failed status', async () => {
    const result = await runContextEngineSut({
      trajectory: makeTrajectory(['format', 'json'], 'not valid json'),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });
});

describe('context-engine SUT introspection', () => {
  it('reports all supported handlers', () => {
    const handlers = getSupportedContextEngineHandlers();
    expect(handlers).toEqual([
      'format',
      'fuzzy-dedup',
      'exact-dedup',
      'budget',
      'incremental-cache',
      'adaptive-memory',
      'pipeline',
    ]);
  });

  it('classifies all previously-unsupported families as supported', () => {
    expect(
      isContextEngineTrajectorySupported(
        makeTrajectory(['incremental', 'cache'], ''),
      ),
    ).toBe(true);
    expect(
      isContextEngineTrajectorySupported(makeTrajectory(['memory', 'adaptive'], '')),
    ).toBe(true);
    expect(
      isContextEngineTrajectorySupported(
        makeTrajectory(['pipeline', 'multi-stage'], ''),
      ),
    ).toBe(true);
  });

  it('reports a trajectory with no tags array as unsupported', () => {
    expect(
      isContextEngineTrajectorySupported(makeTrajectory(undefined as unknown as string[], '')),
    ).toBe(false);
  });
});
