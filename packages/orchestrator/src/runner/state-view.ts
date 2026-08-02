/**
 * State View Factory
 *
 * Creates a filtered view of workflow state for a node. This is the
 * security boundary that enforces read-key permissions — nodes only
 * see the memory keys listed in their `read_keys` array.
 *
 * Engine-owned data (taint registry, lesson provenance, HITL state)
 * lives in first-class `WorkflowState` fields, so it is structurally
 * absent from the view's memory. Taint metadata for the node's
 * READABLE keys is re-attached on the dedicated `taint` field
 * (executor-only — never rendered into prompts) so derived-taint
 * propagation works under least-privilege reads.
 *
 * @module runner/state-view
 */

import type { GraphNode } from '../types/graph.js';
import type { WorkflowState, StateView, TaintRegistry } from '../types/state.js';
import { getTaintRegistry } from '../utils/taint.js';

/**
 * Create a filtered state view for a node.
 *
 * If the node's `read_keys` includes `'*'`, full memory access is
 * granted. Otherwise, only the listed keys are visible.
 *
 * @param state - The full workflow state.
 * @param node - The node requesting the view.
 * @returns A state view containing only the permitted memory keys.
 */
export function createStateView(state: WorkflowState, node: GraphNode): StateView {
  const allowedKeys = node.read_keys;

  const memory = allowedKeys.includes('*')
    ? filterInternalKeys(state.memory)
    : filterMemory(state.memory, allowedKeys);

  // Scope taint metadata to the keys this node can actually read, so the
  // agent executor can mark its outputs as derived-tainted when it reads
  // untrusted data. Rides on the dedicated `taint` field — never inside
  // `memory`, so it cannot leak into the model context.
  const fullRegistry = getTaintRegistry(state);
  const viewRegistry: TaintRegistry = {};
  for (const key of Object.keys(memory)) {
    // Object.hasOwn, not `in`: a memory key named `constructor`/`toString`
    // must not pull a prototype member into the view registry.
    if (Object.hasOwn(fullRegistry, key)) viewRegistry[key] = fullRegistry[key];
  }

  return {
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    goal: state.goal,
    constraints: state.constraints,
    memory,
    ...(Object.keys(viewRegistry).length > 0 ? { taint: viewRegistry } : {}),
  };
}

/**
 * Strip `_`-prefixed keys from memory for wildcard access.
 *
 * Engine data no longer lives in memory (schema v2), so this is
 * defense-in-depth: legacy or adapter-written `_` keys must still never
 * reach agent prompts.
 */
function filterInternalKeys(
  memory: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(memory)) {
    if (!key.startsWith('_')) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Build a memory object containing only the specified keys.
 *
 * Supports dot-notation for nested access (e.g. `'user.name'` returns
 * `{ user: { name: '...' } }`). Keys without dots select the matching
 * top-level memory entry by exact name.
 */
function filterMemory(
  memory: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.startsWith('_')) continue; // Block internal keys

    if (key.includes('.')) {
      // Dot-notation: deep pick a nested path
      const picked = deepPick(memory, key);
      if (picked !== undefined) {
        deepMerge(filtered, picked);
      }
    } else if (key in memory) {
      filtered[key] = memory[key];
    }
  }
  return filtered;
}

/**
 * Pick a single dot-notation path from an object.
 *
 * Returns a nested object containing only the specified path,
 * or `undefined` if the path does not exist.
 *
 * @example
 * ```ts
 * deepPick({ user: { name: 'Alice', age: 30 } }, 'user.name')
 * // => { user: { name: 'Alice' } }
 * ```
 */
function deepPick(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  const segments = path.split('.');
  // Block any segment starting with '_'
  if (segments.some(s => s.startsWith('_'))) return undefined;

  // Walk down to verify the path exists and get the leaf value
  let current: unknown = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    if (!(segment in (current as Record<string, unknown>))) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  // Build the nested result from leaf to root
  let result: unknown = current;
  for (let i = segments.length - 1; i >= 0; i--) {
    result = { [segments[i]]: result };
  }
  return result as Record<string, unknown>;
}

/**
 * Deep merge source into target (mutates target).
 * Only merges plain objects; other values are overwritten.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      target[key] = value;
    }
  }
}
