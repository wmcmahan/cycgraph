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
export { a2a } from './a2a.js';
export type { A2ASpec } from './a2a.js';
export { supervisor } from './supervisor.js';
export type { SupervisorSpec } from './supervisor.js';
export { mapReduce } from './map-reduce.js';
export type { MapReduceSpec } from './map-reduce.js';
export { verifier } from './verifier.js';
export type { VerifierLLMJudgeSpec, VerifierExpressionSpec, VerifierJsonPathSpec } from './verifier.js';
export { runTool } from './run-tool.js';
export type { RunToolSpec } from './run-tool.js';
export { voting } from './voting.js';
export type { VotingSpec } from './voting.js';
export { evolution } from './evolution.js';
export type { EvolutionSpec } from './evolution.js';
export { reflection } from './reflection.js';
export type { ReflectionSpec, ReflectionExtractor } from './reflection.js';
export { approval } from './approval.js';
export type { ApprovalSpec } from './approval.js';
export { router } from './router.js';
export type { RouterSpec } from './router.js';
export { synthesizer } from './synthesizer.js';
export type { SynthesizerSpec } from './synthesizer.js';
export { graph, agentsForGraph, toolsForGraph, graphsForGraph, GraphSpecError } from './graph.js';
export type { GraphInputSpec, GraphOutputSpec, InterfaceSchema } from './interface.js';
export { computeRequirements, checkRequirements } from './requirements.js';
export type { GraphRequirements, RequiredTool, RequirementsHost, RequirementsCheck } from './requirements.js';
export { bundle, parseBundle, BundleIntegrityError } from './bundle.js';
export type { BundleMeta } from './bundle.js';
export type { GraphSpec, EdgeSugar, NodeRef } from './graph.js';
export { run, state } from './run.js';
export type { RunInput, RunOptions } from './run.js';
