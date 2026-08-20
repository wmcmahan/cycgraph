/**
 * Overlays
 *
 * Turns resolved changes into the graph and registry the tail runs against.
 * Neither the caller's `Graph` nor their `AgentRegistry` is mutated: a fork is
 * a read of the original, and a caller who forks twice from one graph must get
 * the same answer both times.
 *
 * **Agent changes are scoped to the node.** Rather than rewriting a shared
 * agent entry, an agent change clones that entry under a fork-local id and
 * points the node at the clone. Three nodes sharing a writer agent stay
 * untouched when one of them is given a different model, which is what someone
 * debugging a single node means.
 *
 * @module replay/overlay
 */

import type { Graph, GraphNode } from '../graph/graph.js';
import type { AgentRegistry, AgentRegistryEntry, AgentRegistryConfig } from '../persistence/interfaces.js';
import { validateGraph } from '../graph/graph-validator.js';
import { GraphNodeSchema } from '../graph/graph.js';
import { resolveTarget } from './target.js';
import { isAgentChange, describeChange, type Change, type AgentChange } from './mutations.js';

/** A change that names an agent the registry does not have. */
export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayError';
  }
}

/** Registry that serves fork-local agent clones and delegates everything else. */
class OverlayRegistry implements AgentRegistry {
  constructor(
    private readonly base: AgentRegistry,
    private readonly overrides: Map<string, AgentRegistryEntry>,
  ) {}

  async loadAgent(id: string): Promise<AgentRegistryEntry | null> {
    return this.overrides.get(id) ?? this.base.loadAgent(id);
  }

  register(entry: AgentRegistryConfig): string | Promise<string> {
    return this.base.register(entry);
  }
}

/** One agent change applied to a registry entry, id untouched. */
export function patchEntry(entry: AgentRegistryEntry, c: AgentChange): AgentRegistryEntry {
  switch (c.kind) {
    case 'model':
      return { ...entry, model: c.model, ...(c.provider ? { provider: c.provider } : {}) };
    case 'prompt':
      return { ...entry, system_prompt: c.system_prompt };
    case 'temperature':
      return { ...entry, temperature: c.temperature };
  }
}

/** Point a node's agent reference at a fork-local clone. */
function repointNode(node: GraphNode, role: string | undefined, from: string, to: string): GraphNode {
  if (role === undefined) {
    if (node.agent_id === from) return { ...node, agent_id: to };
    if (node.supervisor_config?.agent_id === from) {
      return { ...node, supervisor_config: { ...node.supervisor_config, agent_id: to } };
    }
    return node;
  }

  switch (role) {
    case 'candidate':
      return { ...node, evolution_config: { ...node.evolution_config!, candidate_agent_id: to } };
    case 'evaluator':
      if (node.verifier_config?.type === 'llm_judge') {
        return { ...node, verifier_config: { ...node.verifier_config, evaluator_agent_id: to } };
      }
      if (node.evolution_config?.evaluator_agent_id === from) {
        return { ...node, evolution_config: { ...node.evolution_config, evaluator_agent_id: to } };
      }
      return { ...node, annealing_config: { ...node.annealing_config!, evaluator_agent_id: to } };
    case 'judge':
      return { ...node, voting_config: { ...node.voting_config!, judge_agent_id: to } };
    case 'extractor': {
      const config = node.reflection_config;
      if (config?.extractor.type !== 'llm') return node;
      return {
        ...node,
        reflection_config: { ...config, extractor: { ...config.extractor, agent_id: to } },
      };
    }
    case 'voters':
      return {
        ...node,
        voting_config: {
          ...node.voting_config!,
          voter_agent_ids: node.voting_config!.voter_agent_ids.map(id => (id === from ? to : id)),
        },
      };
    default:
      return node;
  }
}

/** The graph and registry a forked tail executes against. */
export interface Overlays {
  graph: Graph;
  registry: AgentRegistry;
  /** Fork-local agent ids created, keyed by the node they belong to. */
  clonedAgents: Record<string, string>;
}

/**
 * Build the overlaid graph and registry for a set of changes.
 *
 * @param graph    The base run's graph.
 * @param registry Where the base run's agents come from.
 * @param changes  Already conflict-checked.
 *
 * @throws {TargetError}  If a change names a node or role the graph lacks.
 * @throws {OverlayError} If a change names an agent the registry lacks.
 */
export async function applyOverlays(
  graph: Graph,
  registry: AgentRegistry,
  changes: readonly Change[],
): Promise<Overlays> {
  let nodes = graph.nodes;
  const overrides = new Map<string, AgentRegistryEntry>();
  const clonedAgents: Record<string, string> = {};

  const replaceNode = (nodeId: string, next: (node: GraphNode) => GraphNode): void => {
    nodes = nodes.map(n => (n.id === nodeId ? next(n) : n));
  };

  // A substituted output is a statement about what the node produces, so it
  // carries the grant to produce it. Without this the runner rejects the
  // caller's own declaration: `change.output('draft', { score })` dies on
  // draft's write keys, while `change.memory({ set: { score } })` — the same
  // statement in a different form — goes through. The grant is not a bypass:
  // it is authored by whoever forked the run, recorded in `fork_mutations`,
  // and scoped to the node named.
  for (const c of changes) {
    if (c.kind !== 'output' && c.kind !== 'tool') continue;
    const produced = c.kind === 'output'
      ? Object.keys(c.memory)
      : [`${c.node_id}_result`];
    if (produced.length === 0) continue;

    const nodeId = c.node_id;
    if (!nodes.some(n => n.id === nodeId)) {
      const names = nodes.map(n => n.id).join(', ');
      throw new OverlayError(
        `${describeChange(c)}: no node '${nodeId}' in this graph. Nodes: ${names}.`,
      );
    }
    replaceNode(nodeId, node => (
      node.write_keys.includes('*')
        ? node
        : { ...node, write_keys: [...new Set([...node.write_keys, ...produced])] }
    ));
  }

  for (const c of changes) {
    if (c.kind === 'config') {
      const exists = nodes.some(n => n.id === c.node_id);
      if (!exists) {
        const names = nodes.map(n => n.id).join(', ');
        throw new OverlayError(
          `${describeChange(c)}: no node '${c.node_id}' in this graph. Nodes: ${names}.`,
        );
      }
      // The patch is arbitrary caller input landing on a schema'd node, so it
      // is re-validated the way any other node authoring is. A patch that
      // breaks the node schema would otherwise surface as an obscure runtime
      // failure deep in the tail, long after the mistake that caused it.
      const patched = GraphNodeSchema.safeParse({ ...nodes.find(n => n.id === c.node_id)!, ...c.patch });
      if (!patched.success) {
        const issues = patched.error.issues
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        throw new OverlayError(`${describeChange(c)}: the patched node fails validation — ${issues}`);
      }
      replaceNode(c.node_id, () => patched.data);
      continue;
    }

    if (!isAgentChange(c)) continue;

    const target = resolveTarget({ ...graph, nodes }, c.target);
    for (const agentId of target.agentIds) {
      // Repeated changes on one node accumulate onto the same clone, so
      // model and prompt changes on one target compose instead of the second
      // dropping the first.
      const cloneId = clonedAgents[`${target.nodeId}:${target.role ?? 'agent'}:${agentId}`]
        ?? `${target.nodeId}${target.role ? `.${target.role}` : ''}@fork`;
      const current = overrides.get(cloneId) ?? await registry.loadAgent(agentId);
      if (!current) {
        throw new OverlayError(
          `${describeChange(c)}: agent '${agentId}' behind '${c.target}' is not in the registry.`,
        );
      }

      overrides.set(cloneId, { ...patchEntry(current, c), id: cloneId });
      clonedAgents[`${target.nodeId}:${target.role ?? 'agent'}:${agentId}`] = cloneId;
      replaceNode(target.nodeId, node => repointNode(node, target.role, agentId, cloneId));
    }
  }

  const overlaid = nodes === graph.nodes ? graph : { ...graph, nodes };

  // Config patches can break more than a node's own shape — an edge condition
  // referencing a removed key, a supervisor managing a node that no longer
  // routes. Graph-level validation catches what node-level parsing cannot, and
  // only runs when something structural was actually patched.
  if (changes.some(c => c.kind === 'config')) {
    const validation = validateGraph(overlaid);
    if (!validation.valid) {
      throw new OverlayError(
        `The patched graph fails validation: ${validation.errors.join('; ')}`,
      );
    }
  }

  return {
    graph: overlaid,
    registry: overrides.size > 0 ? new OverlayRegistry(registry, overrides) : registry,
    clonedAgents,
  };
}
