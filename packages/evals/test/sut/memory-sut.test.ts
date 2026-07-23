/**
 * Unit tests for the memory SUT.
 *
 * Runs known trajectories through the dispatch + library calls to verify
 * the wrapper produces sensible output for each supported category.
 */

import { describe, it, expect } from 'vitest';
import {
  runMemorySut,
  getSupportedMemoryHandlers,
  isMemoryTrajectorySupported,
} from '../../src/sut/memory-sut.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

function makeTrajectory(
  tags: string[],
  input: string,
  overrides: Partial<GoldenTrajectory> = {},
): GoldenTrajectory {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    suite: 'memory',
    description: 'test',
    input,
    expectedOutput: '',
    tags,
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('runMemorySut — segmentation', () => {
  it('segments messages with a 1-hour gap into 2 episodes', async () => {
    const messages = JSON.stringify([
      { role: 'user', content: 'Tell me about the project', timestamp: '2026-01-01T10:00:00Z' },
      { role: 'assistant', content: 'The project uses a graph engine', timestamp: '2026-01-01T10:01:00Z' },
      { role: 'user', content: 'What about the budget?', timestamp: '2026-01-01T11:00:00Z' },
      { role: 'assistant', content: 'The budget is 100k', timestamp: '2026-01-01T11:01:00Z' },
    ]);

    const result = await runMemorySut({
      trajectory: makeTrajectory(['segmentation', 'episodes'], messages),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { episodes: number };
    expect(parsed.episodes).toBeGreaterThanOrEqual(2);
  });

  it('keeps a single conversation as one episode', async () => {
    const messages = JSON.stringify([
      { role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00Z' },
      { role: 'assistant', content: 'Hi', timestamp: '2026-01-01T10:01:00Z' },
    ]);

    const result = await runMemorySut({
      trajectory: makeTrajectory(['segmentation', 'episodes'], messages),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { episodes: number };
    expect(parsed.episodes).toBe(1);
  });
});

describe('runMemorySut — temporal', () => {
  it('filters expired and future facts', async () => {
    const facts = JSON.stringify([
      { content: 'Current fact', valid_from: '2025-01-01' },
      { content: 'Expired fact', valid_from: '2024-01-01', valid_until: '2025-06-01' },
      { content: 'Future fact', valid_from: '2027-01-01' },
    ]);

    const result = await runMemorySut({
      trajectory: makeTrajectory(['temporal', 'validity'], facts),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { filtered_count: number; kept: string[] };
    expect(parsed.filtered_count).toBe(1);
    expect(parsed.kept).toEqual(['Current fact']);
  });

  it('excludes invalidated facts by default', async () => {
    const facts = JSON.stringify([
      { content: 'Valid fact', valid_from: '2025-01-01' },
      { content: 'Invalidated fact', valid_from: '2025-01-01', invalidated_by: 'f-replacement' },
    ]);

    const result = await runMemorySut({
      trajectory: makeTrajectory(['temporal', 'validity'], facts),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { kept: string[] };
    expect(parsed.kept).toEqual(['Valid fact']);
  });
});

describe('runMemorySut — extraction', () => {
  it('extracts entities and facts from free text', async () => {
    const result = await runMemorySut({
      trajectory: makeTrajectory(
        ['extraction', 'rule-based'],
        'Alice works at Acme Corp as lead engineer.',
      ),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      fact_count: number;
      facts: string[];
      entity_count: number;
    };
    expect(parsed.fact_count).toBeGreaterThanOrEqual(1);
  });
});

describe('runMemorySut — unsupported tags', () => {
  it('returns a failed status with a descriptive error for unknown tags', async () => {
    const result = await runMemorySut({
      trajectory: makeTrajectory(['some-future-feature'], 'anything'),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No memory handler');
    expect(result.error).toContain('some-future-feature');
  });

  it('reports failure for empty tags', async () => {
    const result = await runMemorySut({
      trajectory: makeTrajectory([], 'anything'),
    });

    expect(result.status).toBe('failed');
  });
});

describe('runMemorySut — error path', () => {
  it('surfaces library errors as failed status', async () => {
    const result = await runMemorySut({
      trajectory: makeTrajectory(['segmentation', 'episodes'], 'not valid json'),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });
});

describe('runMemorySut — subgraph', () => {
  it('extracts a 1-hop neighborhood from the seeded fixture', async () => {
    const input = JSON.stringify({ seed_entities: ['e-alice'], maxHops: 1 });

    const result = await runMemorySut({
      trajectory: makeTrajectory(['subgraph', 'graph'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      entities: string[];
      relationships: Array<{ type: string }>;
    };
    expect(parsed.entities).toContain('e-alice');
    expect(parsed.relationships.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes expired relationships when validAt is supplied', async () => {
    const input = JSON.stringify({
      seed_entities: ['e-alice'],
      maxHops: 1,
      validAt: '2026-04-06T12:00:00Z',
    });

    const result = await runMemorySut({
      trajectory: makeTrajectory(['subgraph', 'graph'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      relationships: Array<{ type: string }>;
    };
    // The seeded fixture's `manages` edge is expired; the expired one should
    // not appear in the 1-hop output when validAt is the fixture's NOW.
    expect(parsed.relationships.every(r => r.type !== 'manages')).toBe(true);
  });
});

describe('runMemorySut — consolidation', () => {
  it('returns a zero report for an empty store', async () => {
    const result = await runMemorySut({
      trajectory: makeTrajectory(
        ['consolidation', 'cascade'],
        'Run consolidation on empty memory store',
      ),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      factsDeduped: number;
      factsDecayed: number;
      episodesPruned: number;
      totalReclaimed: number;
    };
    expect(parsed.factsDeduped).toBe(0);
    expect(parsed.factsDecayed).toBe(0);
    expect(parsed.episodesPruned).toBe(0);
    expect(parsed.totalReclaimed).toBe(0);
  });

  it('processes inline facts without throwing', async () => {
    const input = JSON.stringify({
      facts: [
        { content: 'Alice works at Acme Corp.' },
        { content: 'Alice is employed by Acme Corp.' },
      ],
    });

    const result = await runMemorySut({
      trajectory: makeTrajectory(['consolidation', 'cascade'], input),
    });

    expect(result.status).toBe('completed');
  });
});

describe('runMemorySut — conflict', () => {
  it('returns conflict count + types for a pair of facts', async () => {
    const input = JSON.stringify({
      factA: 'Alice works at Acme Corp.',
      factB: 'Alice does not work at Acme Corp.',
    });

    const result = await runMemorySut({
      trajectory: makeTrajectory(['conflict', 'negation'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      conflicts_detected: number;
      conflict_types: string[];
    };
    expect(typeof parsed.conflicts_detected).toBe('number');
    expect(Array.isArray(parsed.conflict_types)).toBe(true);
  });

  it('returns zero conflicts for unrelated facts', async () => {
    const input = JSON.stringify({
      factA: 'Alice works at Acme Corp.',
      factB: 'The weather is sunny today.',
    });

    const result = await runMemorySut({
      trajectory: makeTrajectory(['conflict', 'negation'], input),
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { conflicts_detected: number };
    expect(parsed.conflicts_detected).toBe(0);
  });
});

describe('memory SUT introspection', () => {
  it('reports supported handlers', () => {
    const handlers = getSupportedMemoryHandlers();
    expect(handlers).toEqual([
      'segmentation',
      'temporal',
      'extraction',
      'subgraph',
      'consolidation',
      'conflict',
    ]);
  });

  it('classifies all previously-unsupported families as supported', () => {
    expect(isMemoryTrajectorySupported(makeTrajectory(['subgraph', 'graph'], ''))).toBe(true);
    expect(isMemoryTrajectorySupported(makeTrajectory(['consolidation', 'cascade'], ''))).toBe(true);
    expect(isMemoryTrajectorySupported(makeTrajectory(['conflict', 'negation'], ''))).toBe(true);
  });
});
