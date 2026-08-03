import { describe, it, expect } from 'vitest';
import { applyMigrations } from '../../src/dataset/migration.js';
import type { MigrationTransform } from '../../src/dataset/migration.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

function makeTrajectory(overrides: Partial<GoldenTrajectory> = {}): GoldenTrajectory {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    suite: 'orchestrator',
    description: 'Test trajectory',
    input: 'Test input',
    expectedOutput: 'Test output',
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('applyMigrations', () => {
  describe('rename transform', () => {
    it('renames a parameter in matching tool calls', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'web_search', args: { query: 'test', limit: 10 } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({
        search_query: 'test',
        limit: 10,
      });
    });

    it('does not rename params in non-matching tools', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'other_tool', args: { query: 'test' } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({ query: 'test' });
    });

    it('leaves the call unchanged when the matching tool lacks the old param', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'web_search', args: { limit: 10 } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({ limit: 10 });
    });

    it('renames the matching key in expectedArgSchema when the arg is renamed', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          {
            toolName: 'web_search',
            args: { query: 'test' },
            expectedArgSchema: { query: 'string', limit: 'number' },
          },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].expectedArgSchema).toEqual({
        search_query: 'string',
        limit: 'number',
      });
    });

    it('renames the arg but leaves expectedArgSchema untouched when it lacks the old param', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          {
            toolName: 'web_search',
            args: { query: 'test' },
            expectedArgSchema: { limit: 'number' },
          },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({ search_query: 'test' });
      expect(result.trajectories[0].expectedToolCalls![0].expectedArgSchema).toEqual({ limit: 'number' });
    });
  });

  describe('remove transform', () => {
    it('removes a parameter from matching tool calls', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'save_to_memory', args: { key: 'data', deprecated: true } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'remove', toolName: 'save_to_memory', param: 'deprecated' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({ key: 'data' });
    });

    it('leaves the call unchanged when the matching tool lacks the param', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'save_to_memory', args: { key: 'data' } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'remove', toolName: 'save_to_memory', param: 'deprecated' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({ key: 'data' });
    });

    it('removes the param from expectedArgSchema when present', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          {
            toolName: 'save_to_memory',
            args: { key: 'data', deprecated: true },
            expectedArgSchema: { key: 'string', deprecated: 'boolean' },
          },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'remove', toolName: 'save_to_memory', param: 'deprecated' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].expectedArgSchema).toEqual({ key: 'string' });
    });
  });

  describe('add_required transform', () => {
    it('adds a required parameter with stub value', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'fetch_url', args: { url: 'https://example.com' } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'add_required', toolName: 'fetch_url', param: 'timeout_ms', stubValue: 5000 },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({
        url: 'https://example.com',
        timeout_ms: 5000,
      });
      expect(result.reviewRequired).toHaveLength(1);
      expect(result.reviewRequired[0].transform.param).toBe('timeout_ms');
    });

    it('leaves expectedArgSchema unchanged when a required param is added', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          {
            toolName: 'fetch_url',
            args: { url: 'https://example.com' },
            expectedArgSchema: { url: 'string' },
          },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'add_required', toolName: 'fetch_url', param: 'timeout_ms', stubValue: 5000 },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].expectedArgSchema).toEqual({ url: 'string' });
    });

    it('does not overwrite existing parameter', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'fetch_url', args: { url: 'https://example.com', timeout_ms: 3000 } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'add_required', toolName: 'fetch_url', param: 'timeout_ms', stubValue: 5000 },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
      expect(result.trajectories[0].expectedToolCalls![0].args['timeout_ms']).toBe(3000);
    });
  });

  describe('edge cases', () => {
    it('returns unchanged trajectories when no tool calls exist', () => {
      const trajectory = makeTrajectory({ expectedToolCalls: undefined });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'q' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
      expect(result.trajectories[0]).toEqual(trajectory);
    });

    it('returns unchanged trajectories when tool calls are empty', () => {
      const trajectory = makeTrajectory({ expectedToolCalls: [] });

      const transforms: MigrationTransform[] = [
        { type: 'remove', toolName: 'web_search', param: 'query' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(0);
    });

    it('applies multiple transforms in order', () => {
      const trajectory = makeTrajectory({
        expectedToolCalls: [
          { toolName: 'web_search', args: { query: 'test', deprecated: true } },
        ],
      });

      const transforms: MigrationTransform[] = [
        { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
        { type: 'remove', toolName: 'web_search', param: 'deprecated' },
      ];

      const result = applyMigrations([trajectory], transforms);

      expect(result.modifiedCount).toBe(1);
      expect(result.trajectories[0].expectedToolCalls![0].args).toEqual({
        search_query: 'test',
      });
    });
  });
});
