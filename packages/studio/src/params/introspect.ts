/**
 * Parameter introspection
 *
 * Turns a scenario's Zod schema into a flat list of tweakable fields. The CLI
 * renders these as flags; a dashboard renders the same list as form controls.
 * Neither front end reads the schema directly, so neither can drift from it.
 *
 * Derived from `z.toJSONSchema()` rather than Zod's internals, which is the
 * same route `defineTool` takes to publish tool parameters.
 *
 * @module params/introspect
 */

import { z } from 'zod';

/** How a field should be rendered and how its string form is coerced. */
export type FieldKind = 'number' | 'integer' | 'string' | 'boolean' | 'enum' | 'array' | 'json';

/** One tweakable leaf of a scenario's parameter schema. */
export interface ParamField {
  /** Dotted path into the parameter object, e.g. `budget.maxTokens`. */
  path: string;
  /** CLI flag, e.g. `--budget-max-tokens`. */
  flag: string;
  kind: FieldKind;
  /** Value used when the flag is absent. `undefined` for optional fields. */
  default?: unknown;
  /** Allowed values, for `enum`. */
  options?: string[];
  /** From `.describe()`, when present. */
  description?: string;
}

/** Minimal shape of the JSON Schema subset this walks. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  anyOf?: JsonSchemaNode[];
}

/** `budget.maxTokens` → `--budget-max-tokens`. */
export function pathToFlag(path: string): string {
  const kebab = path
    .replace(/\./g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  return `--${kebab}`;
}

function kindOf(node: JsonSchemaNode): FieldKind {
  if (node.enum) return 'enum';
  switch (node.type) {
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'string': return 'string';
    case 'array': return 'array';
    default: return 'json';
  }
}

function walk(node: JsonSchemaNode, prefix: string, out: ParamField[]): void {
  // A nested object contributes its leaves, not itself: `--budget-max-tokens`
  // is tweakable, `--budget` is not.
  if (node.type === 'object' && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }

  const kind = kindOf(node);
  out.push({
    path: prefix,
    flag: pathToFlag(prefix),
    kind,
    ...(node.default !== undefined ? { default: node.default } : {}),
    ...(node.enum ? { options: node.enum.map(String) } : {}),
    ...(node.description ? { description: node.description } : {}),
  });
}

/**
 * Flatten a parameter schema into its tweakable fields.
 *
 * Objects recurse into dotted leaves. Anything without a JSON Schema type this
 * recognises becomes a `json` field, which the CLI accepts as a JSON literal
 * rather than refusing to render.
 */
export function describeParams(schema: z.ZodTypeAny): ParamField[] {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaNode;

  const fields: ParamField[] = [];
  walk(json, '', fields);
  return fields;
}
