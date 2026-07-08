/**
 * Graph Validator
 *
 * Validates graph structure before execution: correctness, completeness,
 * and common misconfigurations. Run at graph load time to fail fast on
 * invalid definitions.
 *
 * Checks performed:
 * - Start/end node existence
 * - Duplicate node/edge IDs
 * - Edge source/target existence
 * - Type-specific config requirements (agent, tool, supervisor, etc.)
 * - Reachability from start node (BFS)
 * - Dead-end detection (non-end nodes with no outgoing edges)
 * - Cycle detection (iterative DFS with three-colour marking)
 *
 * Performance: All lookups use pre-built maps for O(1) access.
 * Total complexity is O(N + E) where N = nodes, E = edges.
 *
 * @module validation/graph-validator
 */

import { compileExpression } from 'filtrex';
import type { Graph, GraphNode, GraphEdge } from '../types/graph.js';
import { FILTREX_COMPILE_OPTIONS, normalizeConditionExpression } from '../utils/condition-expression.js';

/**
 * Result of a graph validation pass.
 *
 * A graph is considered valid only when `errors` is empty. Warnings
 * indicate suspicious-but-valid configurations (e.g. unreachable nodes).
 */
export interface ValidationResult {
  /** `true` if the graph has no errors and is safe to execute. */
  valid: boolean;
  /** Fatal issues that prevent execution. */
  errors: string[];
  /** Suspicious configurations that may indicate mistakes. */
  warnings: string[];
}

/**
 * Validate graph structure: correctness, completeness, and common issues.
 *
 * @param graph - The graph definition to validate.
 * @returns Validation result with errors (invalid graph) and warnings (suspicious but valid).
 */
export function validateGraph(graph: Graph): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Build lookup structures (used by all subsequent checks) ──────────

  const nodeMap = new Map<string, GraphNode>();
  const outgoingEdges = new Map<string, GraphEdge[]>();
  const endNodeSet = new Set<string>(graph.end_nodes);

  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      errors.push(`Duplicate node ID: '${node.id}'`);
    }
    nodeMap.set(node.id, node);
    if (!outgoingEdges.has(node.id)) {
      outgoingEdges.set(node.id, []);
    }

    // Least-privilege nudge: wildcard read access defeats state slicing —
    // the node sees every other node's memory output, including any
    // secrets/PII or tainted external data. Warn so authors scope reads.
    if (node.read_keys.includes('*')) {
      warnings.push(
        `Node '${node.id}': read_keys includes '*' (full memory access) — prefer explicit keys for least privilege`,
      );
    }
    // Symmetric warning for the write side: a wildcard-write node (possibly fed
    // tainted data) can clobber ANY non-`_` memory key — a verifier's
    // `*_passed` flag or an approval-gate decision key that security routing
    // depends on — with no reviewer signal.
    if (node.write_keys.includes('*')) {
      warnings.push(
        `Node '${node.id}': write_keys includes '*' (can overwrite any memory key) — prefer explicit keys for least privilege`,
      );
    }
  }

  // ── Start & end node existence ───────────────────────────────────────

  if (!nodeMap.has(graph.start_node)) {
    errors.push(`Start node '${graph.start_node}' not found in graph nodes`);
  }

  const hasSupervisorNode = graph.nodes.some(n => n.type === 'supervisor');

  if (graph.end_nodes.length === 0 && !hasSupervisorNode) {
    warnings.push('Graph has no end nodes — execution may only terminate via max_iterations or timeout');
  }

  for (const endNodeId of graph.end_nodes) {
    if (!nodeMap.has(endNodeId)) {
      errors.push(`End node '${endNodeId}' not found in graph nodes`);
    }
  }

  // ── Edge validation ──────────────────────────────────────────────────

  const edgeIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate edge ID: '${edge.id}'`);
    }
    edgeIds.add(edge.id);

    if (!nodeMap.has(edge.source)) {
      errors.push(`Edge '${edge.id}': source node '${edge.source}' not found`);
    }
    if (!nodeMap.has(edge.target)) {
      errors.push(`Edge '${edge.id}': target node '${edge.target}' not found`);
    }

    if (edge.source === edge.target) {
      warnings.push(`Edge '${edge.id}': self-referencing edge on node '${edge.source}' (potential tight loop)`);
    }

    if (edge.condition?.type === 'conditional' && !edge.condition.condition) {
      warnings.push(`Edge '${edge.id}': conditional edge is missing a condition expression (will always evaluate to false)`);
    }

    // Try-parse conditional expressions at load time so syntax errors fail
    // graph validation rather than silently returning `false` mid-run and
    // misrouting execution. The validator uses the same compile options as
    // the runtime evaluator (extra functions, dot-access), so any expression
    // that passes here will also compile at evaluation time.
    if (
      (edge.condition?.type === 'conditional' || edge.condition?.type === 'map') &&
      edge.condition.condition
    ) {
      try {
        compileExpression(
          normalizeConditionExpression(edge.condition.condition),
          FILTREX_COMPILE_OPTIONS,
        );
      } catch (e) {
        errors.push(
          `Edge '${edge.id}': condition expression '${edge.condition.condition}' has syntax error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (nodeMap.has(edge.source)) {
      outgoingEdges.get(edge.source)!.push(edge);
    }
  }

  // ── Type-specific node validation (single pass) ──────────────────────

  for (const node of graph.nodes) {
    validateNodeByType(node, nodeMap, outgoingEdges, errors, warnings);

    // default_write_key must be a member of write_keys
    if (node.default_write_key) {
      const hasWildcard = node.write_keys.includes('*');
      if (!hasWildcard && !node.write_keys.includes(node.default_write_key)) {
        errors.push(
          `Node '${node.id}': default_write_key '${node.default_write_key}' is not in write_keys [${node.write_keys.join(', ')}]`,
        );
      }
    }
  }

  // ── Reachability (BFS with index pointer for O(1) dequeue) ───────────

  const reachable = new Set<string>();
  const queue: string[] = [graph.start_node];
  let queueIdx = 0;

  while (queueIdx < queue.length) {
    const current = queue[queueIdx++];
    if (reachable.has(current)) continue;
    reachable.add(current);

    const edges = outgoingEdges.get(current);
    if (edges) {
      for (const edge of edges) {
        if (!reachable.has(edge.target)) {
          queue.push(edge.target);
        }
      }
    }
  }

  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      warnings.push(`Node '${node.id}' is unreachable from start node`);
    }
  }

  // ── Dead-end detection ───────────────────────────────────────────────

  for (const node of graph.nodes) {
    if (endNodeSet.has(node.id)) continue;
    const edges = outgoingEdges.get(node.id);
    if (!edges || edges.length === 0) {
      warnings.push(`Node '${node.id}' has no outgoing edges and is not an end node (potential dead end)`);
    }
  }

  // ── Cycle detection ──────────────────────────────────────────────────

  const hasCycles = detectCycles(graph.nodes, outgoingEdges);
  if (hasCycles && graph.end_nodes.length === 0 && !hasSupervisorNode) {
    warnings.push('Graph contains cycles but has no end nodes (potential infinite loop)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Type-specific Node Validation ──────────────────────────────────

/**
 * Validate a single node based on its `type`.
 *
 * Pushes errors (fatal) and warnings (suspicious) into the
 * provided arrays. Extracted from `validateGraph` for readability.
 */
function validateNodeByType(
  node: GraphNode,
  nodeMap: Map<string, GraphNode>,
  outgoingEdges: Map<string, GraphEdge[]>,
  errors: string[],
  warnings: string[],
): void {
  switch (node.type) {
    case 'agent': {
      if (!node.agent_id) {
        errors.push(`Agent node '${node.id}' is missing agent_id`);
      }
      if (node.annealing_config) {
        if (node.annealing_config.initial_temperature < node.annealing_config.final_temperature) {
          warnings.push(
            `Agent node '${node.id}': annealing initial_temperature (${node.annealing_config.initial_temperature}) ` +
            `is less than final_temperature (${node.annealing_config.final_temperature}) — temperature will increase instead of decrease`,
          );
        }
      }
      if (node.swarm_config) {
        for (const peerId of node.swarm_config.peer_nodes) {
          if (!nodeMap.has(peerId)) {
            errors.push(`Swarm node '${node.id}': peer node '${peerId}' not found in graph`);
          }
        }
        for (const peerId of node.swarm_config.peer_nodes) {
          const peerOutgoing = outgoingEdges.get(peerId);
          const hasReturnEdge = peerOutgoing?.some(e => e.target === node.id) ?? false;
          if (!hasReturnEdge) {
            warnings.push(`Swarm node '${node.id}': no return edge from peer '${peerId}' (handoff back may not be possible)`);
          }
        }
      }
      break;
    }

    case 'tool': {
      if (!node.tool_id) {
        errors.push(`Tool node '${node.id}' is missing tool_id`);
      }
      break;
    }

    case 'subgraph': {
      if (!node.subgraph_config) {
        errors.push(`Subgraph node '${node.id}' is missing subgraph_config`);
      } else if (!node.subgraph_config.subgraph_id) {
        errors.push(`Subgraph node '${node.id}' is missing subgraph_config.subgraph_id`);
      }
      break;
    }

    case 'approval': {
      if (!node.approval_config) {
        errors.push(`Approval node '${node.id}' is missing approval_config`);
      } else if (node.approval_config.rejection_node_id && !nodeMap.has(node.approval_config.rejection_node_id)) {
        errors.push(
          `Approval node '${node.id}': rejection_node_id '${node.approval_config.rejection_node_id}' not found in graph`,
        );
      }
      break;
    }

    case 'map': {
      if (!node.map_reduce_config) {
        errors.push(`Map node '${node.id}' is missing map_reduce_config`);
      } else {
        const { worker_node_id, synthesizer_node_id } = node.map_reduce_config;
        if (!nodeMap.has(worker_node_id)) {
          errors.push(`Map node '${node.id}': worker node '${worker_node_id}' not found in graph`);
        }
        if (synthesizer_node_id && !nodeMap.has(synthesizer_node_id)) {
          errors.push(`Map node '${node.id}': synthesizer node '${synthesizer_node_id}' not found in graph`);
        }
      }
      break;
    }

    case 'voting': {
      if (!node.voting_config) {
        errors.push(`Voting node '${node.id}' is missing voting_config`);
      } else {
        if (node.voting_config.voter_agent_ids.length === 0) {
          errors.push(`Voting node '${node.id}': voter_agent_ids must not be empty`);
        }
        if (node.voting_config.strategy === 'llm_judge' && !node.voting_config.judge_agent_id) {
          errors.push(`Voting node '${node.id}': llm_judge strategy requires judge_agent_id`);
        }
      }
      break;
    }

    case 'supervisor': {
      if (!node.supervisor_config) {
        errors.push(`Supervisor node '${node.id}' is missing supervisor_config`);
      } else {
        if (!node.supervisor_config.agent_id && !node.agent_id) {
          errors.push(`Supervisor node '${node.id}' is missing agent_id (set on the node or in supervisor_config)`);
        }
        const { managed_nodes } = node.supervisor_config;

        for (const managedId of managed_nodes) {
          if (!nodeMap.has(managedId)) {
            errors.push(`Supervisor '${node.id}': managed node '${managedId}' not found in graph`);
          }
        }

        const supervisorOutgoing = outgoingEdges.get(node.id) ?? [];
        for (const managedId of managed_nodes) {
          if (!supervisorOutgoing.some(e => e.target === managedId)) {
            warnings.push(`Supervisor '${node.id}' has no edge to managed node '${managedId}'`);
          }
        }

        if (managed_nodes.includes(node.id)) {
          warnings.push(`Supervisor '${node.id}' manages itself (potential infinite loop)`);
        }
      }
      break;
    }

    case 'evolution': {
      if (!node.evolution_config) {
        errors.push(`Evolution node '${node.id}' is missing evolution_config`);
      } else {
        const evoConfig = node.evolution_config;
        if (evoConfig.elite_count >= evoConfig.population_size) {
          errors.push(`Evolution node '${node.id}': elite_count must be less than population_size`);
        }
        if (evoConfig.selection_strategy === 'tournament' &&
          evoConfig.tournament_size > evoConfig.population_size) {
          errors.push(`Evolution node '${node.id}': tournament_size exceeds population_size`);
        }
        if (evoConfig.initial_temperature < evoConfig.final_temperature) {
          warnings.push(`Evolution node '${node.id}': temperature increases over generations (exploration grows)`);
        }
      }
      break;
    }

    case 'reflection': {
      if (!node.reflection_config) {
        errors.push(`Reflection node '${node.id}' is missing reflection_config`);
        break;
      }
      const refConfig = node.reflection_config;
      const readKeys = new Set(node.read_keys);
      const wildcard = readKeys.has('*');
      if (!wildcard) {
        for (const key of refConfig.source_keys) {
          if (!readKeys.has(key)) {
            errors.push(
              `Reflection node '${node.id}': source_key '${key}' not in read_keys`,
            );
          }
        }
        for (const key of refConfig.entity_keys ?? []) {
          if (!readKeys.has(key)) {
            errors.push(
              `Reflection node '${node.id}': entity_key '${key}' not in read_keys`,
            );
          }
        }
      }
      if (refConfig.tags.length === 0) {
        warnings.push(
          `Reflection node '${node.id}': no tags set — facts will be retrievable by anyone with the same memory store`,
        );
      }
      break;
    }

    // router, synthesizer, verifier — no type-specific cross-field checks
    // beyond what Zod enforces on the discriminated config schemas.
    default:
      break;
  }
}

// ─── Cycle Detection ────────────────────────────────────────────────

/** DFS node states for three-colour cycle detection. */
const enum DFSColor {
  /** Unvisited. */
  WHITE = 0,
  /** In the current DFS path (on the recursion stack). */
  GRAY = 1,
  /** Fully explored (all descendants processed). */
  BLACK = 2,
}

/**
 * Detect if the graph contains at least one cycle.
 *
 * Uses iterative DFS with three-colour marking (White/Gray/Black)
 * to avoid stack overflow on large/deep graphs. A back-edge to a
 * GRAY node indicates a cycle.
 *
 * @param nodes - All graph nodes.
 * @param outgoingEdges - Pre-built adjacency map (`node_id → edges[]`).
 * @returns `true` if the graph contains at least one cycle.
 */
function detectCycles(
  nodes: readonly GraphNode[],
  outgoingEdges: Map<string, GraphEdge[]>,
): boolean {
  const color = new Map<string, DFSColor>();
  for (const node of nodes) {
    color.set(node.id, DFSColor.WHITE);
  }

  for (const node of nodes) {
    if (color.get(node.id) !== DFSColor.WHITE) continue;

    // Stack entries: [nodeId, edgeIndex]
    const stack: Array<[string, number]> = [[node.id, 0]];
    color.set(node.id, DFSColor.GRAY);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [currentId, edgeIdx] = top;
      const edges = outgoingEdges.get(currentId) ?? [];

      if (edgeIdx >= edges.length) {
        color.set(currentId, DFSColor.BLACK);
        stack.pop();
        continue;
      }

      // Advance to next edge for when we return to this node
      top[1]++;

      const neighbor = edges[edgeIdx].target;
      const neighborColor = color.get(neighbor);

      if (neighborColor === DFSColor.GRAY) {
        return true; // Back edge → cycle
      }

      if (neighborColor === DFSColor.WHITE) {
        color.set(neighbor, DFSColor.GRAY);
        stack.push([neighbor, 0]);
      }
    }
  }

  return false;
}
