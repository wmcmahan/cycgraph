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
export { graph, agentsForGraph, toolsForGraph, GraphSpecError } from './graph.js';
export type { GraphSpec, EdgeSugar, NodeRef } from './graph.js';
export { run, state } from './run.js';
export type { RunInput, RunOptions } from './run.js';
