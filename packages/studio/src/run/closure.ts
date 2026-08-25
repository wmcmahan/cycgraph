/**
 * Closure threading
 *
 * A facade-authored graph carries its inline `agent()` configs, `tool()`
 * implementations, and `subgraph()` children on identity-keyed stashes.
 * `run()` unpacks those itself, but it also owns the agent registry, which the
 * playground cannot give up: parameters change an agent's model between runs,
 * and a Postgres-backed registry has to be able to replace the in-memory one.
 *
 * So the playground unpacks the same stashes into the stack's registry, and
 * recurses so `subgraph()` grandchildren resolve identically.
 *
 * @module run/closure
 */

import {
  agentsForGraph,
  graphsForGraph,
  toolsForGraph,
  type AgentRegistry,
  type DefinedTool,
  type Graph,
} from '@cycgraph/orchestrator';

/** Runner options derived from a graph's inline references. */
export interface ThreadedClosure {
  /** Inline tool implementations, for `GraphRunnerOptions.tools`. */
  tools: DefinedTool[];
  /** Resolver for `subgraph()` children, absent when the graph embeds none. */
  loadGraph?: (graphId: string) => Promise<Graph | null>;
}

/**
 * Register a graph's inline agents and collect its inline tools and children.
 *
 * Facade agent configs carry deterministic ids, so re-registering the same
 * scenario across runs overwrites its own entries rather than accumulating
 * duplicates.
 *
 * @param root - The graph about to run.
 * @param agents - Registry the stack owns.
 */
export async function threadClosure(root: Graph, agents: AgentRegistry): Promise<ThreadedClosure> {
  const tools: DefinedTool[] = [];
  const children = new Map<string, Graph>();
  const seen = new Set<Graph>();

  const visit = async (graph: Graph): Promise<void> => {
    if (seen.has(graph)) return;
    seen.add(graph);

    for (const config of agentsForGraph(graph)) {
      await agents.register(config);
    }
    for (const tool of toolsForGraph(graph)) {
      if (!tools.includes(tool)) tools.push(tool);
    }
    for (const child of graphsForGraph(graph)) {
      children.set(child.id, child);
      await visit(child);
    }
  };

  await visit(root);

  return {
    tools,
    ...(children.size > 0
      ? { loadGraph: async (graphId: string) => children.get(graphId) ?? null }
      : {}),
  };
}

/**
 * Every child graph in the composition's stash closure, recursively.
 * What a run path persists alongside the root so later readers (fork
 * resolution, the importer) can resolve child sessions from the store.
 */
export function childGraphsOf(root: Graph): Graph[] {
  const children: Graph[] = [];
  const seen = new Set<Graph>([root]);
  const visit = (graph: Graph): void => {
    for (const child of graphsForGraph(graph)) {
      if (seen.has(child)) continue;
      seen.add(child);
      children.push(child);
      visit(child);
    }
  };
  visit(root);
  return children;
}
