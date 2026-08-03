import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  assertToolCallStructure,
  assertTrajectoryStructure,
} from '../../src/assertions/zod-structural.js';
import type { ToolCall } from '../../src/dataset/types.js';

describe('assertToolCallStructure', () => {
  describe('tool name matching', () => {
    it('passes when tool names match', () => {
      const actual: ToolCall = { toolName: 'web_search', args: { query: 'test' } };
      const expected: ToolCall = { toolName: 'web_search', args: { query: 'different value' } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(true);
      expect(result.toolName).toBe('web_search');
    });

    it('fails when tool names differ', () => {
      const actual: ToolCall = { toolName: 'fetch_url', args: { query: 'test' } };
      const expected: ToolCall = { toolName: 'web_search', args: { query: 'test' } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.typeMismatches[0].param).toBe('__toolName__');
    });
  });

  describe('forgiving value comparison', () => {
    it('passes when values differ but types match', () => {
      const actual: ToolCall = {
        toolName: 'web_search',
        args: { query: 'OpenAI CEO' },
      };
      const expected: ToolCall = {
        toolName: 'web_search',
        args: { query: 'CEO of OpenAI' },
      };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(true);
      expect(result.missingParams).toEqual([]);
      expect(result.typeMismatches).toEqual([]);
    });

    it('passes with different numeric values', () => {
      const actual: ToolCall = { toolName: 'search', args: { limit: 5 } };
      const expected: ToolCall = { toolName: 'search', args: { limit: 10 } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(true);
    });
  });

  describe('missing parameters', () => {
    it('fails when a required parameter is missing', () => {
      const actual: ToolCall = { toolName: 'web_search', args: {} };
      const expected: ToolCall = { toolName: 'web_search', args: { query: 'test' } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.missingParams).toContain('query');
    });

    it('passes when actual has extra parameters', () => {
      const actual: ToolCall = {
        toolName: 'web_search',
        args: { query: 'test', extra_param: 'bonus' },
      };
      const expected: ToolCall = { toolName: 'web_search', args: { query: 'test' } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(true);
    });
  });

  describe('type mismatches', () => {
    it('fails when parameter type differs', () => {
      const actual: ToolCall = { toolName: 'search', args: { limit: 'five' } };
      const expected: ToolCall = { toolName: 'search', args: { limit: 5 } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.typeMismatches).toHaveLength(1);
      expect(result.typeMismatches[0]).toEqual({
        param: 'limit',
        expected: 'number',
        received: 'string',
      });
    });

    it('distinguishes null from object', () => {
      const actual: ToolCall = { toolName: 'test', args: { data: null } };
      const expected: ToolCall = { toolName: 'test', args: { data: { key: 'value' } } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.typeMismatches[0].expected).toBe('object');
      expect(result.typeMismatches[0].received).toBe('null');
    });

    it('distinguishes array from object', () => {
      const actual: ToolCall = { toolName: 'test', args: { items: { a: 1 } } };
      const expected: ToolCall = { toolName: 'test', args: { items: [1, 2, 3] } };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.typeMismatches[0].expected).toBe('array');
      expect(result.typeMismatches[0].received).toBe('object');
    });
  });

  describe('with Zod schema', () => {
    it('validates against a provided Zod schema', () => {
      const schema = z.object({
        query: z.string(),
        limit: z.number().optional(),
      });

      const actual: ToolCall = { toolName: 'search', args: { query: 'test' } };
      const expected: ToolCall = { toolName: 'search', args: { query: 'test' } };

      const result = assertToolCallStructure(actual, expected, schema);

      expect(result.passed).toBe(true);
    });

    it('reports missing required fields from schema', () => {
      const schema = z.object({
        query: z.string(),
        limit: z.number(),
      });

      const actual: ToolCall = { toolName: 'search', args: { query: 'test' } };
      const expected: ToolCall = { toolName: 'search', args: { query: 'test' } };

      const result = assertToolCallStructure(actual, expected, schema);

      expect(result.passed).toBe(false);
      expect(result.missingParams).toContain('limit');
    });

    it('reports type mismatches from schema', () => {
      const schema = z.object({
        query: z.string(),
        limit: z.number(),
      });

      const actual: ToolCall = { toolName: 'search', args: { query: 'test', limit: 'ten' } };
      const expected: ToolCall = { toolName: 'search', args: { query: 'test', limit: 10 } };

      const result = assertToolCallStructure(actual, expected, schema);

      expect(result.passed).toBe(false);
      expect(result.typeMismatches).toHaveLength(1);
      expect(result.typeMismatches[0].param).toBe('limit');
    });

    it('ignores value-level violations, treating only structural issues as failures', () => {
      const schema = z.object({ query: z.string().min(5) });

      const actual: ToolCall = { toolName: 'search', args: { query: 'ab' } };
      const expected: ToolCall = { toolName: 'search', args: { query: 'ab' } };

      const result = assertToolCallStructure(actual, expected, schema);

      expect(result.passed).toBe(true);
      expect(result.missingParams).toEqual([]);
      expect(result.typeMismatches).toEqual([]);
    });

    it('treats a nested schema path over a primitive value as a missing param', () => {
      const schema = z.any().superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'invalid_type', expected: 'string', path: ['config', 'timeout'], message: 'forced' });
      });

      const actual: ToolCall = { toolName: 'search', args: { config: 5 } };
      const expected: ToolCall = { toolName: 'search', args: { config: 5 } };

      const result = assertToolCallStructure(actual, expected, schema);

      expect(result.passed).toBe(false);
      expect(result.missingParams).toEqual(['config.timeout']);
      expect(result.typeMismatches).toEqual([]);
    });
  });
});

describe('assertTrajectoryStructure', () => {
  it('validates a sequence of tool calls', () => {
    const actual: ToolCall[] = [
      { toolName: 'web_search', args: { query: 'quantum computing' } },
      { toolName: 'save_to_memory', args: { key: 'research', value: 'findings' } },
    ];
    const expected: ToolCall[] = [
      { toolName: 'web_search', args: { query: 'latest quantum computing research' } },
      { toolName: 'save_to_memory', args: { key: 'data', value: 'results' } },
    ];

    const results = assertTrajectoryStructure(actual, expected);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('reports missing tool calls', () => {
    const actual: ToolCall[] = [
      { toolName: 'web_search', args: { query: 'test' } },
    ];
    const expected: ToolCall[] = [
      { toolName: 'web_search', args: { query: 'test' } },
      { toolName: 'save_to_memory', args: { key: 'data' } },
    ];

    const results = assertTrajectoryStructure(actual, expected);

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].typeMismatches[0].param).toBe('__call_index__');
  });
});
