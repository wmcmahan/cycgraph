/**
 * Permanent application of measured changes
 *
 * The counterpart of the fork overlay for changes that have earned their
 * place. A fork applies changes scoped to one tail — agents clone under
 * fork-local ids, substitutions patch a single run's state — and everything
 * it builds is discarded with the run. This applies the same change
 * vocabulary to the graph itself: agents patch in place under their own ids,
 * node configs patch through the same schema validation, and what comes back
 * is a graph that looks authored, because it now is.
 *
 * Only the durable subset of the change vocabulary qualifies. `model`,
 * `prompt`, `temperature`, and `config` describe the workflow; `output`,
 * `tool`, `memory`, `route`, and `human_response` describe one execution of
 * it, and a "permanent" version of those would be a different feature wearing
 * this one's name — so they are rejected by kind rather than half-applied.
 *
 * @module replay/apply
 */

import { GraphNodeSchema, type Graph } from '../graph/graph.js';
import { validateGraph } from '../graph/graph-validator.js';
import type { AgentRegistry, AgentRegistryEntry } from '../persistence/interfaces.js';
import { detectConflicts, describeChange, isAgentChange, type Change } from './mutations.js';
import { patchEntry } from './overlay.js';
import { resolveTarget } from './target.js';

/** A change set that cannot be applied permanently, and why. */
export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

/** Change kinds that describe the workflow rather than one run of it. */
const DURABLE = new Set(['model', 'prompt', 'temperature', 'config']);

/** What applying a change set produced. */
export interface AppliedChanges {
  /** The patched graph, node- and graph-level validated. */
  graph: Graph;
  /**
   * Registry entries whose configuration changed, under their own ids.
   *
   * Returned rather than written, because where agents persist is the
   * caller's concern: an in-memory registry updates in place, a database
   * registry updates a row, and this function should not have to know which
   * it is talking to.
   */
  agents: AgentRegistryEntry[];
}

/**
 * Apply measured changes to a graph and its agents, permanently.
 *
 * @throws {ApplyError} If changes conflict, name a non-durable kind, or the
 *   patched result fails node or graph validation.
 */
export async function applyChanges(
  graph: Graph,
  registry: AgentRegistry,
  changes: readonly Change[],
): Promise<AppliedChanges> {
  const transient = changes.filter(c => !DURABLE.has(c.kind));
  if (transient.length > 0) {
    throw new ApplyError(
      `only model, prompt, temperature, and config changes describe the workflow itself; `
      + `these describe one run of it: ${transient.map(describeChange).join('; ')}`,
    );
  }

  const conflicts = detectConflicts(changes);
  if (conflicts.length > 0) {
    throw new ApplyError(`the changes claim the same thing: ${conflicts.join('; ')}`);
  }

  let nodes = graph.nodes;
  const patched = new Map<string, AgentRegistryEntry>();

  for (const c of changes) {
    if (c.kind === 'config') {
      const node = nodes.find(n => n.id === c.node_id);
      if (!node) {
        throw new ApplyError(
          `${describeChange(c)}: no node '${c.node_id}' in this graph. Nodes: ${nodes.map(n => n.id).join(', ')}.`,
        );
      }
      const result = GraphNodeSchema.safeParse({ ...node, ...c.patch });
      if (!result.success) {
        const issues = result.error.issues
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        throw new ApplyError(`${describeChange(c)}: the patched node fails validation — ${issues}`);
      }
      nodes = nodes.map(n => (n.id === c.node_id ? result.data : n));
      continue;
    }

    if (!isAgentChange(c)) continue;

    const target = resolveTarget({ ...graph, nodes }, c.target);
    for (const agentId of target.agentIds) {
      // Repeated changes to one agent accumulate, so a model change and a
      // prompt change on the same target compose instead of the second
      // starting from the unpatched entry.
      const current = patched.get(agentId) ?? await registry.loadAgent(agentId);
      if (!current) {
        throw new ApplyError(
          `${describeChange(c)}: agent '${agentId}' behind '${c.target}' is not in the registry.`,
        );
      }
      patched.set(agentId, patchEntry(current, c));
    }
  }

  const applied = nodes === graph.nodes ? graph : { ...graph, nodes };
  if (changes.some(c => c.kind === 'config')) {
    const validation = validateGraph(applied);
    if (!validation.valid) {
      throw new ApplyError(`the patched graph fails validation: ${validation.errors.join('; ')}`);
    }
  }

  return { graph: applied, agents: [...patched.values()] };
}
