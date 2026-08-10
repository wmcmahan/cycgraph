/**
 * Composition closure — everything a facade composition carries
 *
 * Walks a graph plus its `subgraph()` children (recursively, so
 * grandchildren resolve too) and folds every graph's stashed agents,
 * inline tools, and child graphs into one collection. `run()` registers
 * from it; `bundle()` embeds from it.
 *
 * @module authoring/closure
 */

import type { Graph } from '../types/graph.js';
import type { AgentRegistryConfig } from '../persistence/interfaces.js';
import type { DefinedTool } from '../tools/define-tool.js';
import type { CapabilityCeiling } from '../tools/registry.js';
import { agentsForGraph, ceilingsForGraph, graphsForGraph, toolsForGraph } from './graph.js';

/** Everything a facade composition needs registered for one run. */
export interface GraphClosure {
  agents: AgentRegistryConfig[];
  tools: DefinedTool[];
  children: Map<string, Graph>;
  /** Declared capability ceilings for embedded bundles, keyed by subgraph id. */
  ceilings: Record<string, CapabilityCeiling>;
}

/**
 * Collect the closure of `root`. Reused values dedupe by identity; the
 * same agent() value compiled into two graphs dedupes by its stable id.
 * Two distinct definitions pinned to one id throw — last-registration-wins
 * would be silent cross-graph contamination.
 */
export function collectClosure(root: Graph): GraphClosure {
  const agents: AgentRegistryConfig[] = [];
  const agentById = new Map<string, string>();
  const tools: DefinedTool[] = [];
  const seenTools = new Set<DefinedTool>();
  const children = new Map<string, Graph>();
  const ceilings: Record<string, CapabilityCeiling> = {};
  const visited = new Set<Graph>([root]);
  const queue: Graph[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;

    Object.assign(ceilings, ceilingsForGraph(current));

    for (const config of agentsForGraph(current)) {
      const id = (config as { id?: string }).id ?? '';
      const serialized = JSON.stringify(config);
      const prior = agentById.get(id);
      if (prior === undefined) {
        agentById.set(id, serialized);
        agents.push(config);
      } else if (prior !== serialized) {
        throw new Error(
          `Agent id "${id}" is defined differently in two graphs of this composition — ` +
            'reuse the same agent() value across graphs, or give each definition its own id',
        );
      }
    }

    for (const toolValue of toolsForGraph(current)) {
      if (!seenTools.has(toolValue)) {
        seenTools.add(toolValue);
        tools.push(toolValue);
      }
    }

    for (const child of graphsForGraph(current)) {
      const existing = children.get(child.id);
      if (existing && existing !== child) {
        throw new Error(
          `Two distinct child graphs share the id "${child.id}" in this composition — ` +
            'reuse the same graph() value, or give each child its own id',
        );
      }
      children.set(child.id, child);
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }

  return { agents, tools, children, ceilings };
}
