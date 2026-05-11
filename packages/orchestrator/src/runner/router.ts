/**
 * Graph Router
 *
 * Pure routing primitives for the runner: where to go next, what's current,
 * and whether the loop should keep iterating. All functions are pure with
 * respect to their arguments — no internal state, no side effects beyond
 * logging.
 *
 * Edge conditions are evaluated via {@link evaluateCondition} from
 * `runner/conditions.ts` (filtrex-based). Routing semantics:
 *
 *   - Walk outgoing edges in declaration order
 *   - Return the target node of the first edge whose condition evaluates `true`
 *   - Return `null` when no condition matches (terminates execution)
 *
 * @module runner/router
 */

import type { Graph, GraphNode, GraphEdge } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import { evaluateCondition } from './conditions.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.router');

/**
 * Resolve the next node to execute given the current node and state.
 *
 * @param edgeMap - Outgoing edges indexed by source node id (built once by
 *   the runner; pre-built for O(1) lookup).
 * @param nodeMap - All nodes indexed by id.
 * @param currentNode - The node that just finished executing.
 * @param state - Current workflow state (used by edge conditions).
 * @returns The next node, or `null` if execution should terminate (no
 *   outgoing edges, or no edge condition matched).
 */
export function getNextNode(
  edgeMap: Map<string, GraphEdge[]>,
  nodeMap: Map<string, GraphNode>,
  currentNode: GraphNode,
  state: WorkflowState,
): GraphNode | null {
  const outgoingEdges = edgeMap.get(currentNode.id);

  if (!outgoingEdges || outgoingEdges.length === 0) {
    return null; // End of graph
  }

  for (const edge of outgoingEdges) {
    if (evaluateCondition(edge.condition, state)) {
      const nextNode = nodeMap.get(edge.target);
      if (nextNode) {
        logger.debug('following_edge', { edge_id: edge.id, target: nextNode.id, from: currentNode.id });
        return nextNode;
      }
    }
  }

  logger.warn('no_matching_edge', { node_id: currentNode.id });
  return null;
}

/**
 * Resolve the current node from `state.current_node`. Returns `null` when
 * the state has no current node (workflow not yet started or already done).
 */
export function getCurrentNode(
  nodeMap: Map<string, GraphNode>,
  state: WorkflowState,
): GraphNode | null {
  if (!state.current_node) return null;
  return nodeMap.get(state.current_node) ?? null;
}

/**
 * Whether the execution loop should keep iterating.
 *
 * End-node detection is handled in the main loop **after** node execution,
 * not here, so that end nodes actually run their logic before termination.
 */
export function shouldContinue(state: WorkflowState): boolean {
  return state.status === 'running' && !!state.current_node;
}

/**
 * Build the outgoing-edge index for a graph. Used by the runner constructor
 * so `getNextNode` can do O(1) lookup. Co-located here so the router owns
 * the edgeMap shape.
 */
export function buildEdgeMap(graph: Graph): Map<string, GraphEdge[]> {
  const edgeMap = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = edgeMap.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      edgeMap.set(edge.source, [edge]);
    }
  }
  return edgeMap;
}
