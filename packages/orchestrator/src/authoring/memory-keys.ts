/**
 * A graph's memory keys, declared once and referenced everywhere.
 *
 * A key that several nodes share has no owner to hang it off: in a repair loop
 * two nodes write the same key, and a third reads it, so `writes` on one node
 * cannot name it for the others. Without a declaration the name is retyped at
 * every use — node grants, verifier targets, edge conditions, the seeded state,
 * and, worst of all, inside prompt text, where a rename leaves the instructions
 * quietly lying.
 *
 * ```ts
 * const mem = memoryKeys({
 *   email_text: { seeded: true, schema: { type: 'string' } },
 *   purchase_order: { schema: { type: 'object' } },
 * });
 *
 * node({ reads: [mem.email_text], writes: mem.purchase_order });
 * graph({ nodes, inputs: mem.inputs });
 * state({ workflowId: g.id, goal, memory: mem.seed({ email_text: body }) });
 * ```
 *
 * `inputs` and `seed` are reserved: a declared key may not use either name.
 *
 * @module authoring/memory-keys
 */

import type { GraphInputDecl } from '../graph/graph.js';
import { GraphSpecError } from './errors.js';

/** What is known about one declared key. */
export interface MemoryKeySpec {
  /**
   * Provided by whoever starts the run rather than written by a node.
   *
   * Seeded keys become the graph's declared `inputs`, which is what lets
   * `strictKeys` tell a seeded value from a typo.
   */
  seeded?: boolean;
  /** JSON Schema for the value. Carried onto the input declaration. */
  schema?: Record<string, unknown>;
  /** Human-readable note, carried onto the input declaration. */
  description?: string;
  /** Whether a seeded key must be supplied. Ignored for keys nodes write. */
  required?: boolean;
}

/** Names that would collide with the helpers on the returned object. */
const RESERVED = ['inputs', 'seed'] as const;

/**
 * The declaration: every key as its own name, plus the two helpers.
 *
 * Each property's type is the key's literal name, so `mem.email_text` is
 * `'email_text'` and a misspelling does not compile.
 */
export type MemoryKeys<S extends Record<string, MemoryKeySpec>> =
  { readonly [K in keyof S & string]: K }
  & {
    /** Declared inputs for the seeded keys, for a graph's `inputs`. */
    readonly inputs: Record<string, GraphInputDecl>;
    /**
     * Initial memory, accepting only declared seeded keys.
     *
     * A key the declaration does not mention, or a required one left out, is
     * a compile error rather than a run that reads an empty value.
     */
    seed(values: SeedValues<S>): Record<string, unknown>;
  };

/** The seeded keys of a declaration, required unless marked otherwise. */
export type SeedValues<S extends Record<string, MemoryKeySpec>> =
  { [K in keyof S as S[K]['seeded'] extends true ? K : never]: unknown };

/**
 * Declare the memory keys a graph works with.
 *
 * @param spec - Each key, and what is known about it.
 * @throws {GraphSpecError} If a key uses a reserved name.
 */
export function memoryKeys<const S extends Record<string, MemoryKeySpec>>(spec: S): MemoryKeys<S> {
  const declaration: Record<string, unknown> = {};

  for (const name of Object.keys(spec)) {
    if ((RESERVED as readonly string[]).includes(name)) {
      throw new GraphSpecError(
        `memoryKeys: '${name}' is reserved — rename the key, or reach it as a plain string`,
      );
    }
    declaration[name] = name;
  }

  const inputs: Record<string, GraphInputDecl> = {};
  for (const [name, entry] of Object.entries(spec)) {
    if (!entry.seeded) continue;
    inputs[name] = {
      schema: entry.schema ?? {},
      required: entry.required ?? true,
      ...(entry.description ? { description: entry.description } : {}),
    };
  }

  // Non-enumerable, so spreading a declaration yields only its keys.
  Object.defineProperty(declaration, 'inputs', { value: inputs, enumerable: false });
  Object.defineProperty(declaration, 'seed', {
    enumerable: false,
    value: (values: Record<string, unknown>): Record<string, unknown> => {
      for (const name of Object.keys(values)) {
        if (!Object.hasOwn(spec, name)) {
          throw new GraphSpecError(
            `memoryKeys.seed: '${name}' is not a declared key`,
          );
        }
        if (!spec[name]!.seeded) {
          throw new GraphSpecError(
            `memoryKeys.seed: '${name}' is written by a node, not seeded — remove it, or declare it \`seeded\``,
          );
        }
      }
      for (const [name, entry] of Object.entries(spec)) {
        if (entry.seeded && (entry.required ?? true) && !Object.hasOwn(values, name)) {
          throw new GraphSpecError(`memoryKeys.seed: required key '${name}' was not supplied`);
        }
      }
      return { ...values };
    },
  });

  return declaration as MemoryKeys<S>;
}
