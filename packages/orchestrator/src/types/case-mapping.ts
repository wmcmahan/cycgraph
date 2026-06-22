/**
 * camelCase ⇄ snake_case mapping for the public authoring layer.
 *
 * The engine, database, and wire format use snake_case. Consumers, however,
 * author graphs, agents, workflow state, and MCP servers in idiomatic
 * camelCase TypeScript. The utilities here bridge the two:
 *
 * - {@link Camelize} derives a camelCase authoring *type* from a snake_case
 *   wire type (so the two never drift).
 * - {@link camelToSnakeDeep} performs the runtime key remap at each public
 *   constructor boundary (`createGraph`, `createWorkflowState`,
 *   `registry.register`, `saveServer`). It is idempotent on snake_case keys,
 *   so wire-format objects pass through unchanged.
 *
 * Snake_case remains the format the engine reads and the database stores —
 * only the authoring surface is camelCase.
 *
 * @module types/case-mapping
 */

/** Convert a snake_case string-literal type to camelCase. */
export type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

/**
 * Recursively rewrite an object type's keys from snake_case to camelCase.
 *
 * - Arrays recurse into their element type.
 * - Index-signature records (`Record<string, X>`) are preserved as-is
 *   (`SnakeToCamel<string>` is `string`), so freeform maps like `metadata`,
 *   `memory`, and `weights` keep arbitrary user keys.
 * - Unions distribute (discriminated config unions are preserved).
 * - `Date` and other built-ins pass through untouched.
 * - Optional / readonly modifiers are preserved (homomorphic mapping).
 */
export type Camelize<T> = T extends (infer U)[]
  ? Camelize<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T as SnakeToCamel<K & string>]: Camelize<T[K]> }
      : T;

/**
 * Keys whose *values* are freeform / user-controlled and must never be
 * key-converted. The field name itself is still snake-cased, but the runtime
 * remap copies the value verbatim so user memory keys, metadata, provider
 * options, env vars, and headers survive untouched.
 *
 * Keys are listed in snake_case (the form they take *after* the field name is
 * converted), so both `providerOptions` and `provider_options` are covered.
 */
export const DEFAULT_OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'metadata',
  'weights',
  'input_mapping',
  'output_mapping',
  'static_items',
  'value',
  'provider_options',
  'memory',
  'env',
  'headers',
]);

/** Convert a single camelCase key to snake_case (a no-op on snake keys). */
export function camelKeyToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Deep camel→snake key remap. Idempotent on snake_case input, so it doubles
 * as a back-compat passthrough for wire-format objects.
 *
 * @param value - The object/array/primitive to remap.
 * @param opaqueKeys - Snake_case keys whose values are copied verbatim
 *   (not key-converted). Defaults to {@link DEFAULT_OPAQUE_KEYS}.
 */
export function camelToSnakeDeep(
  value: unknown,
  opaqueKeys: ReadonlySet<string> = DEFAULT_OPAQUE_KEYS,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => camelToSnakeDeep(item, opaqueKeys));
  }
  // Preserve Date (and other non-plain objects) verbatim.
  if (value instanceof Date) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const snakeKey = camelKeyToSnake(key);
      out[snakeKey] = opaqueKeys.has(snakeKey) ? val : camelToSnakeDeep(val, opaqueKeys);
    }
    return out;
  }
  return value;
}
