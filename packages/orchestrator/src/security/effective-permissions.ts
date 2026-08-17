/**
 * Effective Write Permissions
 *
 * Derives the write grants a node holds beyond its declared `write_keys`.
 * Two families are implied rather than hand-written, because the node's type
 * or config already is the declaration of intent:
 *
 * 1. **Action permissions implied by node type.** A `supervisor` routes
 *    (`handoff` → `control_flow`) and completes the run (`set_status` →
 *    `status`); an `approval` or `subgraph` node pauses for a human
 *    (`request_human_input` → `control_flow`); an agent node with
 *    `swarm_config` hands off to peers.
 *
 * 2. **Executor-owned result keys implied by node config.** A verifier
 *    writes `${result_key}` and `${result_key}_passed`; reflection writes
 *    its envelope; map/voting/evolution write their aggregate keys; a tool
 *    node writes `${id}_result`; a subgraph node writes the parent-side keys
 *    of its `output_mapping`. The executor produces these, so the config
 *    naming them is the grant.
 *
 * `write_keys` remains the authority for what the node's agent may write.
 * Redundantly declaring an implied key is harmless.
 *
 * Shared by the load-time validator and the runner's dispatch-time
 * permission check.
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
  if (node.type === 'approval') return approvalReadKeys(node);

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
 * An approval node's reads, widened by the keys it puts in front of a reviewer.
 *
 * Naming a key in `review_keys` is a declaration that this node shows that key,
 * which is the same statement as reading it. Without the union the two configs
 * silently disagree: the node builds its review payload out of the sliced
 * state, so a key it was told to display but not to read is dropped, and the
 * reviewer is handed an empty panel with nothing to explain it.
 *
 * A wildcard is deliberately NOT widened. `['*']` is the default, and it means
 * "everything this node can see" rather than "escalate this node to everything"
 * — reading it the other way would hand full memory to every approval gate
 * nobody had configured.
 */
function approvalReadKeys(node: GraphNode): string[] {
  const review = node.approval_config?.review_keys ?? [];
  const named = review.filter((key) => key !== '*');
  if (named.length === 0 || node.read_keys.includes('*')) return node.read_keys;

  const union = new Set([...node.read_keys, ...named]);
  // Identity when nothing was added: `withEffectiveReads` returns the same
  // node object in that case, and callers compare by identity.
  return union.size === node.read_keys.length ? node.read_keys : [...union];
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
