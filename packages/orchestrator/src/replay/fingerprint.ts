/**
 * Input fingerprints
 *
 * A hash of everything that determines what a node is about to be asked: the
 * slice of memory it can read, the agent config behind it, and the goal. Two
 * executions with the same fingerprint were handed the same problem.
 *
 * A fork uses this to skip work. When a change affects one branch of a graph,
 * nodes elsewhere are handed exactly what they were handed in the base run, so
 * calling the model again buys a resample of a question already answered.
 *
 * **A hash, never the prompt.** `docs/plans/observability.md` G4 leaves prompt
 * capture blocked on a policy question, because a prompt carries the untrusted
 * and sensitive content the rest of the system is careful with. A digest
 * distinguishes two executions and proves one is a repeat without storing any
 * of it, so this needs none of that policy work.
 *
 * Fingerprints are computed by replay rather than recorded during execution,
 * which means they work on logs written before this existed. The cost is that
 * an agent config edited between the base run and the fork is invisible: the
 * registry reports today's config for both sides. That direction is safe for
 * the guard's purposes — it can make two genuinely different executions look
 * alike only if someone edited the agent underneath the run, and the diff
 * shows the result either way.
 *
 * @module replay/fingerprint
 */

import { createHash } from 'node:crypto';
import type { Graph, GraphNode } from '../graph/graph.js';
import type { WorkflowState } from '../state/state.js';
import type { AgentRegistry } from '../persistence/interfaces.js';
import { withEffectiveReads } from '../security/effective-permissions.js';
import { canonicalJson } from './canonical.js';

/** What goes into a fingerprint. */
export interface FingerprintInput {
  node: GraphNode;
  graph: Graph;
  state: WorkflowState;
  registry: AgentRegistry;
}

/** The memory a node can actually read, by its effective read keys. */
function readSlice(node: GraphNode, graph: Graph, state: WorkflowState): Record<string, unknown> {
  const keys = withEffectiveReads(node, graph).read_keys;
  if (keys.includes('*')) {
    return Object.fromEntries(Object.entries(state.memory).filter(([k]) => !k.startsWith('_')));
  }
  const slice: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(state.memory, key)) slice[key] = state.memory[key];
  }
  return slice;
}

/** The agent fields that change what a model is asked, resolved and hashable. */
async function agentShape(
  registry: AgentRegistry,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const agent = await registry.loadAgent(agentId);
  if (!agent) return null;
  return {
    model: agent.model,
    provider: agent.provider,
    system_prompt: agent.system_prompt,
    temperature: agent.temperature,
    max_steps: agent.max_steps,
    max_output_tokens: agent.max_output_tokens,
    tools: agent.tools,
  };
}

/**
 * Every agent a node drives, keyed by the role that reaches it.
 *
 * Not just `node.agent_id`: a verifier judges through `evaluator_agent_id`, a
 * voting node polls `voter_agent_ids`, an evolution node breeds through
 * `candidate_agent_id`. Hashing only the default agent would leave those node
 * types with no fingerprint, so they would re-execute on every fork and a null
 * fork of a graph containing one could never reproduce itself.
 */
function agentRefs(node: GraphNode): Record<string, string> {
  const refs: Record<string, string> = {};
  const add = (role: string, id: string | undefined): void => {
    if (id) refs[role] = id;
  };

  add('agent', node.agent_id);
  add('supervisor', node.supervisor_config?.agent_id);
  add('candidate', node.evolution_config?.candidate_agent_id);
  add('evolution_evaluator', node.evolution_config?.evaluator_agent_id);
  add('annealing_evaluator', node.annealing_config?.evaluator_agent_id);
  add('judge', node.voting_config?.judge_agent_id);
  if (node.verifier_config?.type === 'llm_judge') {
    add('verifier_evaluator', node.verifier_config.evaluator_agent_id);
  }
  if (node.reflection_config?.extractor.type === 'llm') {
    add('extractor', node.reflection_config.extractor.agent_id);
  }
  node.voting_config?.voter_agent_ids?.forEach((id, i) => add(`voter_${i}`, id));

  return refs;
}

/**
 * Config that decides what a node produces, beyond its agents and its reads.
 *
 * A node with no agent at all is still deterministic in its inputs — a router
 * evaluates conditions, a synthesizer merges what it was given — so its config
 * is what separates two executions of it.
 */
function nodeShape(node: GraphNode): Record<string, unknown> {
  const {
    id: _id, type: _type, read_keys: _reads, write_keys: _writes, ...config
  } = node as unknown as Record<string, unknown>;
  return config;
}

/**
 * Hash what a node is about to be asked.
 *
 * Returns `null` only when an agent the node references cannot be resolved: a
 * partial comparison must never match, or a fork would serve a recording made
 * under config it could not see. A node with no agents hashes fine — its
 * config and read slice are what determine it.
 */
export async function computeFingerprint(input: FingerprintInput): Promise<string | null> {
  const { node, graph, state, registry } = input;

  const agents: Record<string, unknown> = {};
  for (const [role, agentId] of Object.entries(agentRefs(node))) {
    const shape = await agentShape(registry, agentId);
    if (!shape) return null;
    agents[role] = shape;
  }

  const digest = createHash('sha256');
  digest.update(canonicalJson({
    node: node.id,
    type: node.type,
    config: nodeShape(node),
    goal: state.goal,
    constraints: state.constraints,
    reads: readSlice(node, graph, state),
    agents,
  }));

  return digest.digest('hex');
}
