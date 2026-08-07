/**
 * graph() — the compiler of the authoring facade
 *
 * Takes inert `node()` values (or raw node configs), resolves every branded
 * reference — {@link AgentValue}s to minted registry ids (on `agent` or deep
 * inside config blocks: `candidateAgentId`, `evaluatorAgentId`,
 * `voterAgentIds`, …), {@link NodeValue}s to their node ids (edge
 * `from`/`to`, `startNode`/`endNodes`, `managedNodes`) — expands edge
 * sugar, infers start/end when unambiguous, and emits the serializable
 * snake_case wire `Graph` via {@link createGraph}. The topology stays fully
 * explicit.
 *
 * The agent configs a graph references are stashed in a WeakMap keyed by
 * the returned `Graph`, so the graph itself stays pure JSON while `run()`
 * can register the agents into a run-scoped registry.
 *
 * @module authoring/graph
 */

import type { Graph, GraphConfig, NodeConfig } from '../types/graph.js';
import { createGraph } from '../types/graph.js';
import type { AgentRegistryConfig } from '../persistence/interfaces.js';
import {
  isAgentValue,
  ensureAgentId,
  toRegistryConfig,
  type AgentValue,
} from './agent.js';
import { isNodeValue, NODE_BRAND, type NodeValue, type NodeSpec } from './node.js';
import { isDefinedTool, type DefinedTool } from '../tools/define-tool.js';

/** Agent definitions referenced by a facade-authored graph, for `run()`. */
const graphAgents = new WeakMap<Graph, AgentRegistryConfig[]>();

/** Tool implementations referenced inline by a facade-authored graph, for `run()`. */
const graphTools = new WeakMap<Graph, DefinedTool[]>();

/** Retrieve the agent configs a facade-authored graph references (empty if none). */
export function agentsForGraph(graph: Graph): AgentRegistryConfig[] {
  return graphAgents.get(graph) ?? [];
}

/**
 * Retrieve the `tool()` implementations a facade-authored graph references
 * inline (empty if none). Like {@link agentsForGraph}, the stash is keyed on
 * the graph object's identity: a serialized-and-reloaded graph carries only
 * the `{ type: 'custom', name }` wire references, and the implementations
 * must be supplied to the runner explicitly.
 */
export function toolsForGraph(graph: Graph): DefinedTool[] {
  return graphTools.get(graph) ?? [];
}

/** Anywhere the graph names a node: its id string, or the node value itself. */
export type NodeRef = string | NodeValue;

/** Edge authoring sugar: `from`/`to` node refs, optional filtrex `when`. */
export interface EdgeSugar {
  from: NodeRef;
  to: NodeRef;
  when?: string;
}

/** A full wire edge (camelCase authoring), accepted alongside the sugar. */
type EdgeInput = EdgeSugar | NonNullable<GraphConfig['edges']>[number];

/** Any `nodes` entry: a `node()` value or a plain node config. */
type NodeInput = NodeValue | NodeConfig;

/** Authoring input for {@link graph}. */
export interface GraphSpec {
  name: string;
  description?: string;
  nodes: NodeInput[];
  edges?: EdgeInput[];
  startNode?: NodeRef;
  endNodes?: NodeRef[];
  /** Reject conditions that reference tainted memory keys. See taint tracking. */
  strictTaint?: boolean;
}

/** Thrown when the graph shape can't be resolved (dup ids, ambiguous start/end). */
export class GraphSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphSpecError';
  }
}

/** True for object literals only — Date/Map/class instances are NOT plain. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Resolve a node reference to its id string. */
function nodeId(ref: NodeRef): string {
  if (typeof ref === 'string') return ref;
  const id = ref.id;
  if (!id) throw new GraphSpecError('Referenced node value has no id');
  return id;
}

function isEdgeSugar(edge: EdgeInput): edge is EdgeSugar {
  return 'from' in edge && 'to' in edge;
}

function expandEdge(edge: EdgeInput): NonNullable<GraphConfig['edges']>[number] {
  if (!isEdgeSugar(edge)) return edge;
  return {
    source: nodeId(edge.from),
    target: nodeId(edge.to),
    ...(edge.when ? { condition: { type: 'conditional' as const, condition: edge.when } } : {}),
  };
}

/** Collectors for the references `graph()` resolves out of node specs. */
interface RefCollector {
  agent(value: AgentValue): void;
  tool(value: DefinedTool): void;
}

/**
 * Deep-resolve inline references anywhere in a node spec: agent values
 * become registry ids (collected for registration, deduped by identity),
 * node values become their node ids, and `tool()` implementations collapse
 * to their serializable `{ type: 'custom', name }` source (collected for
 * `run()` to register on the runner). Generic by design — the reference is
 * identified by its own shape regardless of which config field carries it,
 * so new node types need no facade changes.
 */
function resolveRefs(value: unknown, collect: RefCollector): unknown {
  if (isAgentValue(value)) {
    collect.agent(value);
    return ensureAgentId(value);
  }
  if (isNodeValue(value)) {
    return nodeId(value);
  }
  if (isDefinedTool(value)) {
    collect.tool(value);
    return { type: 'custom', name: value.name };
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, collect));
  }
  // Recurse into PLAIN objects only (mirroring camelToSnakeDeep): rebuilding
  // a Date, Map, or class instance via Object.entries would silently destroy
  // it — a Date becomes `{}` and a downstream deadline never fires.
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = resolveRefs(entry, collect);
    }
    return out;
  }
  return value;
}

/** Expand a `node()` value (or raw config) to a camelCase node config. */
function expandNode(input: NodeInput, collect: RefCollector): NodeConfig {
  if (isAgentValue(input)) {
    throw new GraphSpecError(
      'An agent() value is a capability, not a placement — wrap it: node({ id, agent, reads, writes })',
    );
  }

  // Strip the brand FIRST: object spread copies symbol keys, and a still-
  // branded `rest` would make resolveRefs treat the whole config as a node
  // reference and collapse it to its id.
  const { [NODE_BRAND]: _brand, agent: agentRef, reads, writes, ...rest } =
    input as NodeSpec & { [NODE_BRAND]?: true } & Record<string, unknown>;

  const config = resolveRefs(rest, collect) as Record<string, unknown>;
  if (agentRef !== undefined) {
    config.agentId = isAgentValue(agentRef)
      ? (collect.agent(agentRef), ensureAgentId(agentRef))
      : agentRef;
  }
  // An agent reference implies the node type, whether it arrived via the
  // facade `agent` field or as a raw `agentId`. Nodes with a different type
  // (supervisor, evolution, …) declare it explicitly, so `??=` never clobbers.
  if (config.agentId !== undefined) config.type ??= 'agent';
  if (reads !== undefined) config.readKeys = reads;
  if (writes !== undefined) config.writeKeys = Array.isArray(writes) ? writes : [writes];

  return config as NodeConfig;
}

/**
 * Compile authoring values into a wire graph. Everything `createGraph`
 * accepts still works here; `graph()` adds node values, reference
 * resolution, edge sugar, and start/end inference.
 */
export function graph(spec: GraphSpec): Graph {
  const collectedAgents = new Set<AgentValue>();
  const collectedTools = new Set<DefinedTool>();
  const collect: RefCollector = {
    agent: (a) => { collectedAgents.add(a); },
    tool: (t) => { collectedTools.add(t); },
  };

  const nodes: NodeConfig[] = [];
  const seenIds = new Set<string>();
  for (const entry of spec.nodes) {
    const config = expandNode(entry, collect);
    const id = (config as { id?: string }).id;
    if (!id) throw new GraphSpecError('Every node needs an id');
    if (seenIds.has(id)) throw new GraphSpecError(`Duplicate node id "${id}"`);
    seenIds.add(id);
    nodes.push(config);
  }

  const edges = (spec.edges ?? []).map(expandEdge);
  const { startNode, endNodes } = resolveEndpoints(spec, edges, seenIds);

  const built = createGraph({
    name: spec.name,
    description: spec.description ?? '',
    nodes,
    edges,
    startNode,
    endNodes,
    ...(spec.strictTaint !== undefined ? { strictTaint: spec.strictTaint } : {}),
  });

  if (collectedAgents.size > 0) {
    // Two DISTINCT agent() values pinned to the same id would race in the
    // run registry (last registration wins, silently). Same-value reuse
    // across nodes is fine — the Set already deduped by identity.
    // toRegistryConfig also surfaces tool() references carried on agent
    // specs, so agent-level inline tools land in the same stash.
    const configs = [...collectedAgents].map((value) => toRegistryConfig(value, collect.tool));
    const byId = new Map<string, number>();
    for (const config of configs) {
      byId.set(config.id, (byId.get(config.id) ?? 0) + 1);
    }
    for (const [id, count] of byId) {
      if (count > 1) {
        throw new GraphSpecError(
          `${count} distinct agent() definitions share the id "${id}" — reuse the same agent() ` +
            'value across nodes, or give each definition its own id',
        );
      }
    }
    graphAgents.set(built, configs);
  }

  if (collectedTools.size > 0) {
    // Two DISTINCT tool() implementations sharing a name would collide at
    // runner construction with a confusing duplicate-name error; catch it
    // here where the graph is still in the author's hands. Same-value reuse
    // is fine — the Set deduped by identity.
    const byName = new Map<string, number>();
    for (const tool of collectedTools) {
      byName.set(tool.name, (byName.get(tool.name) ?? 0) + 1);
    }
    for (const [name, count] of byName) {
      if (count > 1) {
        throw new GraphSpecError(
          `${count} distinct tool() definitions share the name "${name}" — reuse the same tool() ` +
            'value across nodes, or rename one',
        );
      }
    }
    graphTools.set(built, [...collectedTools]);
  }
  return built;
}

/**
 * Infer `startNode` (the single node with no inbound edge) and `endNodes`
 * (nodes with no outbound edge) when the caller didn't set them. Ambiguity
 * is an error, not a guess.
 */
function resolveEndpoints(
  spec: GraphSpec,
  edges: Array<{ source: string; target: string }>,
  ids: Set<string>,
): { startNode: string; endNodes: string[] } {
  const hasInbound = new Set(edges.map((e) => e.target));
  const hasOutbound = new Set(edges.map((e) => e.source));

  let startNode = spec.startNode !== undefined ? nodeId(spec.startNode) : undefined;
  if (!startNode) {
    const roots = [...ids].filter((id) => !hasInbound.has(id));
    if (roots.length !== 1) {
      throw new GraphSpecError(
        `Cannot infer a start node (${roots.length} nodes have no inbound edge); pass startNode explicitly`,
      );
    }
    startNode = roots[0];
  }

  let endNodes = spec.endNodes?.map(nodeId);
  if (!endNodes) {
    endNodes = [...ids].filter((id) => !hasOutbound.has(id));
    if (endNodes.length === 0) {
      throw new GraphSpecError(
        'Cannot infer end nodes (every node has an outbound edge); pass endNodes explicitly',
      );
    }
  }

  return { startNode, endNodes };
}
