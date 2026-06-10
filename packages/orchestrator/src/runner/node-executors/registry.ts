/**
 * Node Executor Registry
 *
 * The single source of truth mapping each `NodeType` to the function that
 * executes it. Replaces the dispatch `switch` that used to live in
 * `GraphRunner.executeNodeLogic`.
 *
 * Two payoffs from making this a `Record<NodeType, NodeExecutor>`:
 *
 * 1. **Exhaustiveness is compiler-enforced.** Add a value to `NodeTypeSchema`
 *    and the build fails here until you register an executor — no more silently
 *    falling through to `UnsupportedNodeTypeError` at runtime.
 * 2. **One enumerable list of supported types** (`SUPPORTED_NODE_TYPES`) that
 *    the runner, the graph validator, and tooling can all read instead of each
 *    hardcoding their own copy.
 *
 * @module runner/node-executors/registry
 */

import type { GraphNode, NodeType } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import type { NodeExecutorContext } from './context.js';
import { executeAgentNode } from './agent.js';
import { executeToolNode } from './tool.js';
import { executeRouterNode } from './router.js';
import { executeSupervisorNode } from './supervisor.js';
import { executeApprovalNode } from './approval.js';
import { executeMapNode } from './map.js';
import { executeVotingNode } from './voting.js';
import { executeSynthesizerNode } from './synthesizer.js';
import { executeSubgraphNode } from './subgraph.js';
import { executeEvolutionNode } from './evolution.js';
import { executeVerifierNode } from './verifier.js';
import { executeReflectionNode } from './reflection.js';

/**
 * The uniform signature every node executor conforms to: it receives the node,
 * its security-scoped state view, the attempt number, and the executor context,
 * and returns the `Action` to reduce into state.
 */
export type NodeExecutor = (
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
) => Promise<Action>;

/**
 * Every `NodeType` mapped to its executor. The `Record<NodeType, ...>` type
 * makes this exhaustive: a new node type won't compile until it's registered.
 */
export const NODE_EXECUTORS: Record<NodeType, NodeExecutor> = {
  agent: executeAgentNode,
  tool: executeToolNode,
  router: executeRouterNode,
  supervisor: executeSupervisorNode,
  approval: executeApprovalNode,
  map: executeMapNode,
  voting: executeVotingNode,
  synthesizer: executeSynthesizerNode,
  subgraph: executeSubgraphNode,
  evolution: executeEvolutionNode,
  verifier: executeVerifierNode,
  reflection: executeReflectionNode,
};

/** Every node type the runner can execute. Derived from the registry. */
export const SUPPORTED_NODE_TYPES: readonly NodeType[] = Object.keys(NODE_EXECUTORS) as NodeType[];

/** Look up the executor for a node type, or `undefined` if unsupported. */
export function getNodeExecutor(type: NodeType): NodeExecutor | undefined {
  return NODE_EXECUTORS[type];
}
