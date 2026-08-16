/**
 * Taint Tracking Utilities
 *
 * Operates on the `WorkflowState.taint_registry` field.
 * External data (MCP tool results, etc.) is marked as tainted so downstream consumers
 * (supervisors, agents, the security policy, strict_taint routing) know not to trust it.
 *
 * The registry lives on state as a first-class field, so state slicing excludes it structurally.
 *
 * All functions here are pure — registries are values, never mutated.
 *
 * @module security/taint
 */

import type { TaintMetadata, TaintRegistry, WorkflowState } from '../state/state.js';

/**
 * Read the taint registry from workflow state. Returns an empty registry
 * when absent (e.g. a hand-built state that skipped schema defaults).
 */
export function getTaintRegistry(
  state: Pick<WorkflowState, 'taint_registry'>,
): TaintRegistry {
  return state.taint_registry ?? {};
}

/**
 * Return a new registry with `key` marked tainted. Pure — the input
 * registry is never mutated (state changes only happen through reducers).
 */
export function markTainted(
  registry: TaintRegistry,
  key: string,
  meta: TaintMetadata,
): TaintRegistry {
  return { ...registry, [key]: meta };
}

/** Check if a key has an entry in the taint registry. */
export function isTainted(registry: TaintRegistry, key: string): boolean {
  return Object.hasOwn(registry, key);
}

/** Serialized size of a tainted value. `undefined` when it cannot be serialized. */
export function valueBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8');
  } catch {
    return undefined;
  }
}

/** Get taint metadata for a key. */
export function getTaintInfo(
  registry: TaintRegistry,
  key: string,
): TaintMetadata | undefined {
  return Object.hasOwn(registry, key) ? registry[key] : undefined;
}

/**
 * Propagate taint from readable input keys to output keys.
 *
 * If any of the agent's readable memory keys are tainted, all
 * `outputKeys` are marked as `derived`-tainted (the agent may have
 * incorporated tainted data into its output).
 *
 * @param readableMemory - The memory slice the agent could read (its state view).
 * @param registry - Taint registry scoped to those readable keys.
 * @param outputKeys - Memory keys written by the agent.
 * @param agentId - ID of the agent that produced the outputs.
 * @param nodeId - ID of the node the agent ran as.
 * @returns Partial taint registry with only the new entries (empty if no taint propagated).
 */
export function propagateDerivedTaint(
  readableMemory: Record<string, unknown>,
  registry: TaintRegistry,
  outputKeys: string[],
  agentId: string,
  nodeId?: string,
): TaintRegistry {
  // Which inputs were tainted, not merely whether any were: those keys are the
  // lineage recorded on the outputs.
  const taintedInputs = Object.keys(readableMemory)
    .filter((k) => Object.hasOwn(registry, k))
    .sort();

  if (taintedInputs.length === 0) {
    return {};
  }

  const newEntries: TaintRegistry = {};
  const now = new Date().toISOString();

  for (const key of outputKeys) {
    newEntries[key] = {
      source: 'derived',
      agent_id: agentId,
      ...(nodeId ? { node_id: nodeId } : {}),
      derived_from: taintedInputs,
      created_at: now,
    };
  }

  return newEntries;
}

/**
 * Aggregate taint from parallel worker outputs onto a fan-out node's own
 * output keys.
 *
 * The fan-out executors (map / voting / evolution) bury each worker's memory
 * updates under fresh parent keys, including any wire-format
 * `_taint_registry` the worker produced. Re-surfacing that taint is what
 * stops the parent recording an aggregate key as trusted while it holds data
 * derived from untrusted worker output.
 *
 * If any worker produced a non-empty taint registry, every `aggregateKeys`
 * entry is marked `derived`-tainted, attributed to the fan-out node.
 *
 * Called at action-creation time, so the metadata is persisted in the action
 * and replayed verbatim, keeping `created_at` replay-safe.
 *
 * @param workerUpdates - Each worker's memory-updates object (as found on its
 *   action payload); `null`/`undefined`/non-object entries are ignored.
 * @param aggregateKeys - The parent memory keys the fan-out node writes.
 * @param nodeId - ID of the fan-out node, recorded as the taint origin.
 * @returns Partial registry with entries for the aggregate keys (empty if no
 *   worker was tainted).
 */
export function aggregateParallelTaint(
  workerUpdates: Iterable<Record<string, unknown> | null | undefined>,
  aggregateKeys: readonly string[],
  nodeId: string,
): TaintRegistry {
  const taintedWorkerKeys = new Set<string>();
  for (const updates of workerUpdates) {
    if (!updates || typeof updates !== 'object') continue;
    const registry = updates['_taint_registry'];
    if (registry && typeof registry === 'object' && !Array.isArray(registry)) {
      for (const key of Object.keys(registry)) taintedWorkerKeys.add(key);
    }
  }

  if (taintedWorkerKeys.size === 0) {
    return {};
  }

  const newEntries: TaintRegistry = {};
  const now = new Date().toISOString();
  const derivedFrom = [...taintedWorkerKeys].sort();
  for (const key of aggregateKeys) {
    newEntries[key] = {
      source: 'derived',
      node_id: nodeId,
      derived_from: derivedFrom,
      created_at: now,
    };
  }

  return newEntries;
}
