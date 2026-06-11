import { describe, it, expect } from 'vitest';
import {
  ToolCallSchema,
  GoldenTrajectorySchema,
  ManifestEntrySchema,
  ManifestSchema,
} from '../../src/dataset/schema.js';

describe('ToolCallSchema', () => {
  it('accepts a valid tool call with args', () => {
    const result = ToolCallSchema.safeParse({
      toolName: 'web_search',
      args: { query: 'test query' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a tool call with expectedArgSchema', () => {
    const result = ToolCallSchema.safeParse({
      toolName: 'web_search',
      args: { query: 'test' },
      expectedArgSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tool call missing toolName', () => {
    const result = ToolCallSchema.safeParse({ args: { query: 'test' } });
    expect(result.success).toBe(false);
  });
});

describe('GoldenTrajectorySchema', () => {
  const validTrajectory = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    suite: 'orchestrator',
    description: 'Test trajectory',
    input: 'Test input',
    expectedOutput: 'Test output',
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
  };

  it('accepts a valid trajectory with string output', () => {
    const result = GoldenTrajectorySchema.safeParse(validTrajectory);
    expect(result.success).toBe(true);
  });

  it('accepts a valid trajectory with structured output', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      expectedOutput: { entities: ['Alice'], count: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a trajectory with expectedToolCalls', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      expectedToolCalls: [{ toolName: 'web_search', args: { query: 'test' } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a trajectory with empty expectedToolCalls (assert no tools)', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      expectedToolCalls: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a trajectory with tags', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      tags: ['supervisor', 'routing'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid suite name', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      suite: 'nonexistent-package',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid UUID', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid source', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      source: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a trajectory with recording provenance', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      source: 'recorded',
      recordedAt: '2026-06-08T12:00:00Z',
      recordedModel: 'claude-sonnet-4-6',
      recordedCommit: '9dcaa0f',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a recorded trajectory with partial provenance', () => {
    // All three recording fields are independently optional so older datasets
    // that record only commit, or only model, still validate.
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      source: 'recorded',
      recordedCommit: '9dcaa0f',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-ISO recordedAt', () => {
    const result = GoldenTrajectorySchema.safeParse({
      ...validTrajectory,
      recordedAt: 'last Tuesday',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { input: _, ...incomplete } = validTrajectory;
    const result = GoldenTrajectorySchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });
});

describe('ManifestSchema', () => {
  it('accepts a valid manifest with datasets', () => {
    const result = ManifestSchema.safeParse({
      version: '1',
      datasets: [
        {
          name: 'orchestrator',
          file: 'data/orchestrator-v1.sqlite.gz',
          sha256: 'abc123',
          trajectoryCount: 10,
          schemaVersion: '1.0.0',
          lastUpdated: '2026-04-01T00:00:00Z',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty manifest', () => {
    const result = ManifestSchema.safeParse({
      version: '1',
      datasets: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative trajectory count', () => {
    const result = ManifestEntrySchema.safeParse({
      name: 'test',
      file: 'data/test.sqlite.gz',
      sha256: 'abc',
      trajectoryCount: -1,
      schemaVersion: '1.0.0',
      lastUpdated: '2026-04-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});
