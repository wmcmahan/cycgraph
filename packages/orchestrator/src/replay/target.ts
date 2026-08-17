/**
 * Change targets
 *
 * A change names a **node**, never an agent. Agent ids are auto-generated
 * UUIDs that nobody holds by hand, while node ids are authored and already
 * appear in a failure, in `visited_nodes`, and in a diff. The fork resolves
 * node to agent here.
 *
 * A node can reference several agents, so a target takes an optional dotted
 * role: `'evolve.candidate'`, `'review.voters[2]'`. A bare node id means the
 * node's own `agent_id`.
 *
 * @module replay/target
 */

import type { Graph, GraphNode } from '../graph/graph.js';

/** A change target resolved against the graph. */
export interface ResolvedTarget {
  /** The node the change applies to. */
  nodeId: string;
  /** The role addressed, absent for the node's own agent. */
  role?: string;
  /** Agents behind that role. More than one only for `voters`. */
  agentIds: string[];
}

/** A target that does not name something the graph has. */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Every agent reference a node carries, keyed by the role that addresses it. */
function rolesOf(node: GraphNode): Record<string, string[]> {
  const roles: Record<string, string[]> = {};
  const add = (role: string, id: string | undefined): void => {
    if (id) roles[role] = [id];
  };

  add('candidate', node.evolution_config?.candidate_agent_id);
  add('evaluator', node.evolution_config?.evaluator_agent_id
    ?? node.annealing_config?.evaluator_agent_id);
  add('judge', node.voting_config?.judge_agent_id);
  add('extractor', node.reflection_config?.extractor?.type === 'llm'
    ? node.reflection_config.extractor.agent_id
    : undefined);

  if (node.verifier_config?.type === 'llm_judge') {
    roles.evaluator = [node.verifier_config.evaluator_agent_id];
  }
  const voters = node.voting_config?.voter_agent_ids;
  if (voters && voters.length > 0) roles.voters = [...voters];

  return roles;
}

/** The agent a bare node id addresses. */
function defaultAgent(node: GraphNode): string | undefined {
  return node.agent_id ?? node.supervisor_config?.agent_id;
}

/** Split `'review.voters[2]'` into its node, role, and index. */
function parse(target: string): { nodeId: string; role?: string; index?: number } {
  const dot = target.indexOf('.');
  if (dot === -1) return { nodeId: target };

  const nodeId = target.slice(0, dot);
  const rest = target.slice(dot + 1);
  const indexed = /^([A-Za-z_][\w-]*)\[(\d+)\]$/.exec(rest);
  if (indexed) return { nodeId, role: indexed[1], index: Number(indexed[2]) };
  return { nodeId, role: rest };
}

/**
 * Resolve a change target against a graph.
 *
 * @throws {TargetError} If the node, the role, or the voter index is not there.
 */
export function resolveTarget(graph: Graph, target: string): ResolvedTarget {
  const { nodeId, role, index } = parse(target);

  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) {
    const names = graph.nodes.map(n => n.id).join(', ');
    throw new TargetError(`'${target}': no node '${nodeId}' in this graph. Nodes: ${names}.`);
  }

  const roles = rolesOf(node);

  if (role === undefined) {
    const agentId = defaultAgent(node);
    if (!agentId) {
      const available = Object.keys(roles);
      const article = /^[aeiou]/i.test(node.type) ? 'an' : 'a';
      const hint = available.length > 0
        ? `It has these roles: ${available.map(r => `${nodeId}.${r}`).join(', ')}.`
        : `It is ${article} '${node.type}' node, which drives no agent — there is no model, `
          + `prompt, or temperature on it to change. To change what it sees, patch its inputs `
          + `with change.memory({ set: … }); to change what it produces, use `
          + `change.output('${nodeId}', …).`;
      throw new TargetError(`'${target}': node '${nodeId}' has no agent of its own. ${hint}`);
    }
    return { nodeId, agentIds: [agentId] };
  }

  const agentIds = roles[role];
  if (!agentIds) {
    const available = Object.keys(roles);
    const hint = available.length > 0
      ? `Roles on '${nodeId}': ${available.join(', ')}.`
      : `Node '${nodeId}' has no agent roles.`;
    throw new TargetError(`'${target}': no role '${role}'. ${hint}`);
  }

  if (index === undefined) return { nodeId, role, agentIds };

  if (index < 0 || index >= agentIds.length) {
    throw new TargetError(
      `'${target}': '${nodeId}.${role}' has ${agentIds.length} entr(ies), so index ${index} does not exist.`,
    );
  }
  return { nodeId, role, agentIds: [agentIds[index]] };
}
