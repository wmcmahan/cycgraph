import { describe, test, expect } from 'vitest';
import { jsonSchemaToZod } from '../src/mcp/json-schema-converter.js';

describe('jsonSchemaToZod', () => {
  describe('Primitive Types', () => {
    test('converts string type', () => {
      const schema = { type: 'string' };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse('hello')).toBe('hello');
      expect(() => zod.parse(123)).toThrow();
    });

    test('converts number type', () => {
      const schema = { type: 'number' };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse(42)).toBe(42);
      expect(zod.parse(3.14)).toBe(3.14);
      expect(() => zod.parse('hello')).toThrow();
    });

    test('converts integer type as number', () => {
      const schema = { type: 'integer' };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse(42)).toBe(42);
    });

    test('converts boolean type', () => {
      const schema = { type: 'boolean' };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse(true)).toBe(true);
      expect(zod.parse(false)).toBe(false);
      expect(() => zod.parse('yes')).toThrow();
    });
  });

  describe('String with Enum', () => {
    test('converts string enum', () => {
      const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse('red')).toBe('red');
      expect(zod.parse('blue')).toBe('blue');
      expect(() => zod.parse('yellow')).toThrow();
    });
  });

  describe('Object Type', () => {
    test('converts simple object', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };

      const zod = jsonSchemaToZod(schema);
      const result = zod.parse({ name: 'Alice', age: 30 });

      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    test('handles optional fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name'], // email is optional
      };

      const zod = jsonSchemaToZod(schema);

      // Should pass with required only
      expect(zod.parse({ name: 'Alice' })).toEqual({ name: 'Alice' });

      // Should pass with both
      expect(zod.parse({ name: 'Alice', email: 'alice@example.com' }))
        .toEqual({ name: 'Alice', email: 'alice@example.com' });

      // Should fail without required
      expect(() => zod.parse({ email: 'alice@example.com' })).toThrow();
    });

    test('handles nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
        required: ['user'],
      };

      const zod = jsonSchemaToZod(schema);
      const result = zod.parse({ user: { name: 'Alice' } });

      expect(result).toEqual({ user: { name: 'Alice' } });
    });

    test('handles empty properties', () => {
      const schema = { type: 'object' };
      const zod = jsonSchemaToZod(schema);

      expect(zod.parse({})).toEqual({});
    });
  });

  describe('Array Type', () => {
    test('converts array of strings', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' },
      };

      const zod = jsonSchemaToZod(schema);

      expect(zod.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
      expect(() => zod.parse([1, 2, 3])).toThrow();
    });

    test('converts array of objects', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
          },
          required: ['id'],
        },
      };

      const zod = jsonSchemaToZod(schema);
      const result = zod.parse([{ id: 1 }, { id: 2 }]);

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    test('handles array without items', () => {
      const schema = { type: 'array' };
      const zod = jsonSchemaToZod(schema);

      // Should accept any array
      expect(zod.parse([1, 'two', true])).toEqual([1, 'two', true]);
    });
  });

  describe('Unsupported Types', () => {
    test('falls back to z.any() for unknown types', () => {
      const schema = { type: 'null' };
      const zod = jsonSchemaToZod(schema);

      // z.any() accepts anything
      expect(zod.parse(null)).toBe(null);
      expect(zod.parse('anything')).toBe('anything');
    });
  });

  describe('Description Handling', () => {
    test('preserves descriptions on fields', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      };

      const zod = jsonSchemaToZod(schema);
      // Should parse correctly (description doesn't affect validation)
      expect(zod.parse({ query: 'test' })).toEqual({ query: 'test' });
    });
  });

  describe('Real-World MCP Tool Schemas', () => {
    test('converts calculator tool schema', () => {
      const schema = {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
        },
        required: ['operation', 'a', 'b'],
      };

      const zod = jsonSchemaToZod(schema);

      expect(zod.parse({ operation: 'add', a: 2, b: 3 }))
        .toEqual({ operation: 'add', a: 2, b: 3 });

      expect(() => zod.parse({ operation: 'sqrt', a: 4, b: 0 })).toThrow();
    });

    test('converts search tool schema', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results' },
          filters: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['query'],
      };

      const zod = jsonSchemaToZod(schema);

      expect(zod.parse({ query: 'typescript' })).toEqual({ query: 'typescript' });

      expect(zod.parse({ query: 'typescript', limit: 10, filters: ['docs'] }))
        .toEqual({ query: 'typescript', limit: 10, filters: ['docs'] });
    });
  });

  describe('untrusted-manifest bounds', () => {
    it('does not blow the stack on a deeply nested schema', () => {
      // Build a schema nested far beyond the depth cap.
      let schema: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 5000; i++) {
        schema = { type: 'object', properties: { child: schema } };
      }
      // Converts without throwing (RangeError) — depth is bounded.
      expect(() => jsonSchemaToZod(schema as never)).not.toThrow();
    });

    it('caps an object with an enormous number of properties', () => {
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < 5000; i++) properties[`p${i}`] = { type: 'string' };
      expect(() => jsonSchemaToZod({ type: 'object', properties } as never)).not.toThrow();
    });
  });
});
