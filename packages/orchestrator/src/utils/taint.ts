/**
 * Taint Tracking Utilities
 *
 * Operates on the `WorkflowState.taint_registry` field (schema v2 —
 * formerly stashed at `memory._taint_registry`). External data (MCP tool
 * results, etc.) is marked as tainted so downstream consumers
 * (supervisors, agents, the security policy, strict_taint routing) know
 * not to trust it.
 *
 * The registry lives on state as a first-class field, so state slicing
 * excludes it structurally — no prefix conventions involved. Inside
 * ACTION payloads the wire encoding keeps the legacy `_taint_registry`
 * key; reducers route it to the state field (append-only).
 *
 * All functions here are pure — registries are values, never mutated.
 *
 * @module utils/taint
 */

import type { TaintMetadata, TaintRegistry, WorkflowState } from '../types/state.js';

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
  // Object.hasOwn, not `in`: a key named `constructor`/`toString`
  // must not read as tainted via the prototype chain.
  return Object.hasOwn(registry, key);
}

/** Get taint metadata for a key, or `undefined` if not tainted. */
export function getTaintInfo(
  registry: TaintRegistry,
  key: string,
): TaintMetadata | undefined {
  return Object.hasOwn(registry, key) ? registry[key] : undefined;
}

/**
 * Propagate taint from readable input keys to output keys.
 *
 * If **any** of the agent's readable memory keys are tainted, all
 * `outputKeys` are marked as `derived`-tainted (the agent may have
 * incorporated tainted data into its output).
 *
 * @param readableMemory - The memory slice the agent could read (its state view).
 * @param registry - Taint registry scoped to those readable keys.
 * @param outputKeys - Memory keys written by the agent.
 * @param agentId - ID of the agent that produced the outputs.
 * @returns Partial taint registry with only the new entries (empty if no taint propagated).
 */
export function propagateDerivedTaint(
  readableMemory: Record<string, unknown>,
  registry: TaintRegistry,
  outputKeys: string[],
  agentId: string,
): TaintRegistry {
  const hasTaintedInputs = Object.keys(readableMemory).some(
    k => Object.hasOwn(registry, k),
  );

  if (!hasTaintedInputs) {
    return {};
  }

  const newEntries: TaintRegistry = {};
  const now = new Date().toISOString();

  for (const key of outputKeys) {
    newEntries[key] = {
      source: 'derived',
      agent_id: agentId,
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
 * updates — including any wire-format `_taint_registry` the worker produced
 * from MCP or derived taint — under fresh parent keys (e.g. `${node}_results`,
 * `${node}_consensus`, `${node}_winner`). Without re-surfacing that taint, the
 * parent state records the aggregate key as trusted even though it holds data
 * derived from untrusted worker output, and downstream routing / taint gating
 * can't see it. Mirrors the child→parent carry-back the subgraph executor does.
 *
 * If **any** worker produced a non-empty taint registry, every `aggregateKeys`
 * entry is marked `derived`-tainted (attributed to the fan-out node).
 *
 * Called at action-creation time; the resulting metadata is persisted in the
 * action and replayed verbatim, so the `created_at` timestamp is replay-safe
 * (same discipline as {@link propagateDerivedTaint} and MCP taint minting).
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
  let anyTainted = false;
  for (const updates of workerUpdates) {
    if (!updates || typeof updates !== 'object') continue;
    const registry = updates['_taint_registry'];
    if (
      registry &&
      typeof registry === 'object' &&
      !Array.isArray(registry) &&
      Object.keys(registry).length > 0
    ) {
      anyTainted = true;
      break;
    }
  }

  if (!anyTainted) {
    return {};
  }

  const newEntries: TaintRegistry = {};
  const now = new Date().toISOString();
  for (const key of aggregateKeys) {
    newEntries[key] = {
      source: 'derived',
      agent_id: nodeId,
      created_at: now,
    };
  }

  return newEntries;
}
