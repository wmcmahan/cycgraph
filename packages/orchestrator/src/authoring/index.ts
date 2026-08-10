/**
 * Authoring facade — the terse vocabulary.
 *
 * `agent` · `node` · `graph` · `state` · `run` — define agents and nodes,
 * build a graph, seed state, run it. Compiles to the exact same wire as the
 * raw API; the graph API stays available for cyclic/advanced patterns.
 *
 * @module authoring
 */

export { agent, isAgentValue, inferProvider, AgentSpecError } from './agent.js';
export type { AgentSpec, AgentValue } from './agent.js';
export { node, isNodeValue } from './node.js';
export type { NodeValue, NodeSpec } from './node.js';
export { subgraph } from './subgraph.js';
export type { SubgraphSpec } from './subgraph.js';
export { graph, agentsForGraph, toolsForGraph, graphsForGraph, GraphSpecError } from './graph.js';
export type { GraphInputSpec, GraphOutputSpec, InterfaceSchema } from './interface.js';
export { computeRequirements, checkRequirements } from './requirements.js';
export type { GraphRequirements, RequiredTool, RequirementsHost, RequirementsCheck } from './requirements.js';
export { bundle, parseBundle, BundleIntegrityError } from './bundle.js';
export type { BundleMeta } from './bundle.js';
export type { GraphSpec, EdgeSugar, NodeRef } from './graph.js';
export { run, state } from './run.js';
export type { RunInput, RunOptions } from './run.js';
