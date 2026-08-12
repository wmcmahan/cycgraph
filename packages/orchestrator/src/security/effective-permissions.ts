/**
 * Effective Write Permissions
 *
 * Derives the write grants a node holds BEYOND its declared `write_keys`.
 * Two families are implied rather than hand-written, because in both cases
 * the node's type or config already IS the declaration of intent:
 *
 * 1. **Action permissions implied by node type.** A `supervisor` node exists
 *    to route (`handoff` → `control_flow`) and to complete the run
 *    (`set_status` → `status`); an `approval` or `subgraph` node exists to
 *    pause for a human (`request_human_input` → `control_flow`); an agent
 *    node with `swarm_config` exists to hand off to peers. Requiring authors
 *    to also spell these out as pseudo-keys in `write_keys` was the single
 *    most common way to ship a graph that could not run.
 *
 * 2. **Executor-owned result keys implied by node config.** The verifier
 *    ALWAYS writes `${result_key}` and `${result_key}_passed`; reflection
 *    always writes its envelope; map/voting/evolution always write their
 *    aggregate keys; a tool node writes `${id}_result`; a subgraph node
 *    writes the parent-side keys of its `output_mapping`. These writes are
 *    produced by the executor, not authored by an LLM — the config that
 *    names them is the grant.
 *
 * `write_keys` remains the authority for what the node's AGENT may write
 * (its LLM-authored output). Redundantly declaring an implied key is
 * harmless.
 *
 * Lives in `validation/` so both the load-time validator (dangling-read
 * analysis) and the runner (dispatch-time permission check) can share it
 * without a `validation → runner` dependency.
 *
 * @module security/effective-permissions
 */

import type { Graph, GraphNode } from '../graph/graph.js';

/**
 * Action-permission pseudo-keys implied by the node's type/config.
 * See `validateAction` in `state/reducers.ts` for what each token gates.
 */
export function impliedActionPermissions(node: GraphNode): string[] {
  const implied: string[] = [];
  switch (node.type) {
    case 'supervisor':
      // handoff → control_flow; completion set_status → status.
      implied.push('control_flow', 'status');
      break;
    case 'approval':
    case 'subgraph':
    case 'a2a':
      // request_human_input → control_flow. An `a2a` node pauses for the
      // same reason a subgraph does: the far side asked a human a question
      // (`input-required`) and the run has to wait for the answer.
      implied.push('control_flow');
      break;
    case 'agent':
      // A swarm-mode agent emits handoff actions when delegating to a peer.
      if (node.swarm_config) implied.push('control_flow');
      break;
    default:
      break;
  }
  return implied;
}

/**
 * Executor-owned memory keys this node's own machinery writes, derived from
 * its type and config. The agent-node text-output fallback key
 * (`${id}_output`) is deliberately NOT implied: granting it would change the
 * output-routing heuristics for existing graphs (the sole-concrete-key rule
 * would stop firing).
 */
export function impliedResultKeys(node: GraphNode): string[] {
  const keys: string[] = [];
  switch (node.type) {
    case 'verifier': {
      const resultKey = node.verifier_config?.result_key ?? `${node.id}_verification`;
      keys.push(resultKey, `${resultKey}_passed`);
      break;
    }
    case 'reflection': {
      keys.push(node.reflection_config?.result_key ?? `${node.id}_reflection`);
      break;
    }
    case 'map':
      keys.push(
        `${node.id}_results`,
        `${node.id}_errors`,
        `${node.id}_count`,
        `${node.id}_error_count`,
      );
      break;
    case 'voting':
      keys.push(`${node.id}_consensus`, `${node.id}_votes`);
      break;
    case 'evolution':
      keys.push(
        `${node.id}_winner`,
        `${node.id}_winner_fitness`,
        `${node.id}_winner_reasoning`,
        `${node.id}_generation`,
        `${node.id}_fitness_history`,
        `${node.id}_population`,
        `${node.id}_budget_stopped`,
      );
      break;
    case 'tool':
      keys.push(`${node.id}_result`);
      break;
    case 'a2a':
      // Same reasoning as `subgraph`: the executor writes the parent-side
      // keys of the output mapping, and the mapping that names them is the
      // declaration.
      keys.push(...Object.values(node.a2a_config?.output_mapping ?? {}));
      break;
    case 'subgraph':
      // The output mapping's PARENT-side keys. The subgraph executor writes
      // them by copying the child's memory out at the boundary — executor
      // machinery naming its own destinations, exactly like a verifier's
      // `result_key`. The mapping is authored by the parent graph, never by
      // an LLM and never by the child, so the config that names the key is
      // the grant.
      keys.push(...Object.values(node.subgraph_config?.output_mapping ?? {}));
      break;
    case 'synthesizer':
      // The agent-less merge path writes `${id}_synthesis`. (The agent path
      // routes output through the agent's write keys like any agent node.)
      keys.push(`${node.id}_synthesis`);
      break;
    default:
      break;
  }
  return keys;
}

/**
 * The read keys a node's state view is sliced by. For most nodes this is
 * exactly the declared `read_keys`. A SUPERVISOR that declares none derives
 * its reads from topology: a supervisor's structural job is routing over
 * its team's outputs, so it sees the union of its `managed_nodes`' write
 * keys plus each managed node's auto-output fallback (`${id}_output`) —
 * least privilege without the `['*']` boilerplate every supervisor
 * otherwise hand-writes (and the validator warns about). `goal` and
 * `constraints` are always visible to every node regardless.
 *
 * Explicit `read_keys` on a supervisor override the derivation entirely.
 * Derivation is one level deep: a managed supervisor contributes nothing
 * itself (supervisors write no memory); declare reads explicitly for
 * nested-delegation visibility.
 */
export function effectiveReadKeys(node: GraphNode, graph: Graph): string[] {
  if (node.type !== 'supervisor' || node.read_keys.length > 0) {
    return node.read_keys;
  }

  const managed = node.supervisor_config?.managed_nodes ?? [];
  const derived = new Set<string>();
  for (const managedId of managed) {
    const managedNode = graph.nodes.find((n) => n.id === managedId);
    // Declared writes PLUS implied result keys: a managed verifier / tool /
    // map / subgraph node produces its result keys through implication, so
    // deriving from `write_keys` alone would hide from the supervisor the
    // very output it is supposed to route on. Action pseudo-keys
    // (`control_flow`, `status`) are deliberately excluded — they gate
    // dispatch, they are not memory a reader can slice.
    for (const key of managedNode?.write_keys ?? []) derived.add(key);
    for (const key of managedNode ? impliedResultKeys(managedNode) : []) derived.add(key);
    derived.add(`${managedId}_output`);
  }
  return [...derived];
}

/**
 * A node with its {@link effectiveReadKeys} applied — the SINGLE way derived
 * reads enter execution. Used by the node-execution driver (state-view
 * slicing), the security-policy gate (tainted-readable computation), and the
 * executor context's view builder, so visibility and its taint gating can
 * never disagree. Returns the same object when nothing is derived, so
 * identity checks stay valid.
 */
export function withEffectiveReads(node: GraphNode, graph: Graph): GraphNode {
  const readKeys = effectiveReadKeys(node, graph);
  return readKeys === node.read_keys ? node : { ...node, read_keys: readKeys };
}

/**
 * The full set of write grants the runner's dispatch-time permission check
 * validates a node's action against: declared `write_keys` plus everything
 * implied by the node's type and config.
 */
export function effectiveWriteKeys(node: GraphNode): string[] {
  return [
    ...node.write_keys,
    ...impliedActionPermissions(node),
    ...impliedResultKeys(node),
  ];
}

/**
 * Ceiling-and-grant intersection (ADR 001).
 *
 * The NODE's keys are the authoritative *grant* (need-to-know is a property
 * of the graph position). The AGENT registry's permissions, when present,
 * are a *ceiling* — "this agent may never touch more than X, anywhere". The
 * effective permission is their intersection.
 *
 * Semantics:
 *  - `ceiling === undefined` → the agent imposes no cap; the grant governs.
 *    (A registry entry without a `permissions` block is uncapped.)
 *  - An EXPLICIT empty ceiling (`permissions: { write_keys: [] }`) still
 *    means deny-all — a deliberately locked-down agent stays locked down.
 *  - `'*'` on either side defers to the other side's list.
 *  - `grant === undefined` (executor invoked outside a graph node) → the
 *    ceiling alone governs; with no ceiling either, the result is `['*']`.
 */
export function intersectWriteGrant(
  grant: string[] | undefined,
  ceiling: string[] | undefined,
): string[] {
  if (ceiling === undefined) return grant ?? ['*'];
  if (grant === undefined) return ceiling;
  if (ceiling.includes('*')) return grant;
  if (grant.includes('*')) return ceiling;
  const cap = new Set(ceiling);
  return grant.filter((k) => cap.has(k));
}
