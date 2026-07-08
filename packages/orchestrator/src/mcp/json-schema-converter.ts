/**
 * JSON Schema → Zod Converter
 *
 * Required because the AI SDK v6 `tool()` function expects Zod schemas
 * for input validation, while MCP tools provide JSON Schema definitions.
 * This converter bridges the gap at tool-loading time.
 *
 * Supported type mappings:
 * | JSON Schema      | Zod equivalent                   |
 * |------------------|----------------------------------|
 * | `object`         | `z.object({…})` (recursive)      |
 * | `string`         | `z.string()` or `z.enum([…])`    |
 * | `number`/`integer` | `z.number()`                  |
 * | `boolean`        | `z.boolean()`                    |
 * | `array`          | `z.array(itemSchema)`            |
 * | Unknown          | `z.any()` (graceful fallback)    |
 *
 * @module mcp/json-schema-converter
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger.js';

/**
 * Subset of JSON Schema used by MCP tool input definitions.
 */
export interface JSONSchema {
  /** Schema type: `"object"`, `"string"`, `"number"`, `"integer"`, `"boolean"`, `"array"`. */
  type: string;
  /** Property schemas for `object` types. */
  properties?: Record<string, JSONSchema>;
  /** Item schema for `array` types. */
  items?: JSONSchema;
  /** Required property names for `object` types. */
  required?: string[];
  /** Human-readable description of the schema. */
  description?: string;
  /** Allowed values for enum constraints. */
  enum?: unknown[];
}

const logger = createLogger('mcp.schema');

/**
 * MCP tool schemas come from an untrusted server manifest. Bound the recursion
 * depth and per-object breadth so a hostile deep/wide schema can't drive
 * unbounded recursion or allocation while being converted.
 */
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_PROPERTIES = 1000;

/**
 * Convert a JSON Schema object to a Zod schema.
 *
 * This is the public entry point. It delegates to type-specific converters
 * and falls back to `z.any()` on unrecognised types (never throws).
 *
 * @param schema - JSON Schema object from an MCP tool definition.
 * @returns Equivalent Zod schema for AI SDK compatibility.
 */
export function jsonSchemaToZod(schema: JSONSchema): z.ZodType {
  return convertWithDepth(schema, 0);
}

function convertWithDepth(schema: JSONSchema, depth: number): z.ZodType {
  // Past the depth cap, stop recursing and accept anything. This bounds a
  // hostile deeply-nested manifest without throwing.
  if (depth >= MAX_SCHEMA_DEPTH) {
    logger.warn('schema_depth_exceeded', { depth });
    return z.any();
  }
  try {
    switch (schema.type) {
      case 'object':
        return convertObjectSchema(schema, depth);

      case 'string':
        return convertStringSchema(schema);

      case 'number':
      case 'integer':
        return z.number();

      case 'boolean':
        return z.boolean();

      case 'array':
        return convertArraySchema(schema, depth);

      default:
        logger.warn('unsupported_schema_type', { type: schema.type });
        return z.any();
    }
  } catch (error) {
    logger.warn('schema_conversion_error', { error: error instanceof Error ? error.message : String(error) });
    return z.any();
  }
}

/**
 * Convert a JSON Schema `object` type to `z.object()`.
 *
 * Recursively converts each property, applies `.describe()` if a
 * description is present, and marks non-required properties as `.optional()`.
 */
function convertObjectSchema(schema: JSONSchema, depth: number): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  // Cap the number of properties converted from an untrusted manifest.
  const entries = Object.entries(properties).slice(0, MAX_SCHEMA_PROPERTIES);
  if (Object.keys(properties).length > MAX_SCHEMA_PROPERTIES) {
    logger.warn('schema_properties_capped', { count: Object.keys(properties).length, cap: MAX_SCHEMA_PROPERTIES });
  }

  for (const [key, propSchema] of entries) {
    let zodType = convertWithDepth(propSchema, depth + 1);

    if (propSchema.description) {
      zodType = zodType.describe(propSchema.description);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

/**
 * Convert a JSON Schema `string` type to `z.string()` or `z.enum()`.
 *
 * If the schema has an `enum` constraint with at least one value,
 * returns `z.enum()` instead of `z.string()`.
 */
function convertStringSchema(schema: JSONSchema): z.ZodType {
  if (schema.enum && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  return z.string();
}

/**
 * Convert a JSON Schema `array` type to `z.array()`.
 *
 * Falls back to `z.array(z.any())` if no `items` schema is specified.
 */
function convertArraySchema(schema: JSONSchema, depth: number): z.ZodArray<z.ZodType> {
  if (!schema.items) {
    return z.array(z.any());
  }

  return z.array(convertWithDepth(schema.items, depth + 1));
}
