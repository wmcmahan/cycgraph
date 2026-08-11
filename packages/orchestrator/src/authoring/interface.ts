/**
 * Graph interface authoring — Zod in, JSON Schema on the wire
 *
 * A graph's `inputs`/`outputs` declare its public signature at a subgraph
 * boundary. They are authored as Zod schemas
 * (or raw JSON Schema, or full declaration entries) and projected to the
 * wire form via `z.toJSONSchema`, the same projection tool `parameters`
 * already use. This module owns that conversion plus the compile-time
 * validation of a subgraph node's mappings against a child's declared
 * interface.
 *
 * @module authoring/interface
 */

import { z } from 'zod';
import type { Graph, GraphInputDecl, GraphOutputDecl } from '../graph/graph.js';
import { GraphSpecError } from './errors.js';

/** A declared value schema: a Zod type, or raw JSON Schema passed through. */
export type InterfaceSchema = z.ZodType | Record<string, unknown>;

/** Authoring entry for one input key: bare schema, or schema plus flags. */
export type GraphInputSpec =
  | InterfaceSchema
  | { schema: InterfaceSchema; required?: boolean; description?: string };

/** Authoring entry for one output key: bare schema, or schema plus description. */
export type GraphOutputSpec =
  | InterfaceSchema
  | { schema: InterfaceSchema; description?: string };

function isZod(value: InterfaceSchema): value is z.ZodType {
  return value instanceof z.ZodType;
}

function isEntry(value: unknown): value is { schema: InterfaceSchema } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schema' in value &&
    (isZod((value as { schema: InterfaceSchema }).schema) ||
      typeof (value as { schema: unknown }).schema === 'object')
  );
}

function project(schema: InterfaceSchema, io: 'input' | 'output', key: string): Record<string, unknown> {
  if (!isZod(schema)) return schema;
  try {
    return z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  } catch (error) {
    throw new GraphSpecError(
      `Interface key "${key}" has a Zod schema that cannot be represented as JSON Schema: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Convert authored inputs to the wire declaration record. */
export function toWireInputs(
  inputs: Record<string, GraphInputSpec>,
): Record<string, GraphInputDecl> {
  const wire: Record<string, GraphInputDecl> = {};
  for (const [key, spec] of Object.entries(inputs)) {
    if (isEntry(spec) && !isZod(spec as InterfaceSchema)) {
      const entry = spec as { schema: InterfaceSchema; required?: boolean; description?: string };
      wire[key] = {
        schema: project(entry.schema, 'input', key),
        required: entry.required ?? deriveRequired(entry.schema),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      };
    } else {
      const schema = spec as InterfaceSchema;
      wire[key] = { schema: project(schema, 'input', key), required: deriveRequired(schema) };
    }
  }
  return wire;
}

/** Convert authored outputs to the wire declaration record. */
export function toWireOutputs(
  outputs: Record<string, GraphOutputSpec>,
): Record<string, GraphOutputDecl> {
  const wire: Record<string, GraphOutputDecl> = {};
  for (const [key, spec] of Object.entries(outputs)) {
    if (isEntry(spec) && !isZod(spec as InterfaceSchema)) {
      const entry = spec as { schema: InterfaceSchema; description?: string };
      wire[key] = {
        schema: project(entry.schema, 'output', key),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      };
    } else {
      wire[key] = { schema: project(spec as InterfaceSchema, 'output', key) };
    }
  }
  return wire;
}

/** A Zod type that accepts `undefined` (optional / defaulted) is not required. */
function deriveRequired(schema: InterfaceSchema): boolean {
  if (!isZod(schema)) return true;
  return !schema.safeParse(undefined).success;
}

/**
 * Validate a subgraph node's mappings against the child's declared
 * interface, when it has one. Hard errors, per the settled decision:
 * a mapped key absent from the declaration does not compile, and a
 * required input left unmapped does not compile. A child without a
 * declared interface validates nothing (graceful degradation).
 */
export function validateChildInterface(
  child: Graph,
  nodeId: string,
  config: { inputMapping?: Record<string, string>; outputMapping?: Record<string, string> },
): void {
  const inputMapping = config.inputMapping ?? {};
  const outputMapping = config.outputMapping ?? {};

  if (child.inputs) {
    const declared = child.inputs;
    for (const [parentKey, childKey] of Object.entries(inputMapping)) {
      if (!(childKey in declared)) {
        throw new GraphSpecError(
          `Subgraph node "${nodeId}" maps parent key "${parentKey}" to child input "${childKey}", ` +
          `but graph "${child.name}" declares no such input. Declared inputs: ${Object.keys(declared).join(', ') || '(none)'}`,
        );
      }
    }
    const mappedChildKeys = new Set(Object.values(inputMapping));
    for (const [key, decl] of Object.entries(declared)) {
      if (decl.required && !mappedChildKeys.has(key)) {
        throw new GraphSpecError(
          `Subgraph node "${nodeId}" does not map required input "${key}" of graph "${child.name}" — ` +
          `add it to inputs (e.g. inputs: { <parentKey>: '${key}' })`,
        );
      }
    }
  }

  if (child.outputs) {
    const declared = child.outputs;
    for (const childKey of Object.keys(outputMapping)) {
      if (!(childKey in declared)) {
        throw new GraphSpecError(
          `Subgraph node "${nodeId}" maps child output "${childKey}", but graph "${child.name}" ` +
          `declares no such output. Declared outputs: ${Object.keys(declared).join(', ') || '(none)'}`,
        );
      }
    }
  }
}
