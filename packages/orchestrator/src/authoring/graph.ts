/**
 * graph() — the compiler of the authoring facade
 *
 * Takes inert `node()` values and resolves every branded reference:
 * {@link AgentValue}s to minted registry ids, including deep inside config
 * blocks, and {@link NodeValue}s to their node ids. Expands edge sugar,
 * infers start/end when unambiguous, and emits the snake_case wire `Graph`
 * via {@link createGraph}.
 *
 * Referenced agent configs are stashed in a WeakMap keyed by the returned
 * `Graph`, so the graph stays pure JSON while `run()` can register them
 * into a run-scoped registry.
 *
 * @module authoring/graph
 */

import type { Graph, GraphConfig, NodeConfig } from '../graph/graph.js';
import { createGraph } from '../graph/graph.js';
import type { AgentRegistryConfig } from '../persistence/interfaces.js';
import {
  isAgentValue,
  ensureAgentId,
  toRegistryConfig,
  type AgentValue,
} from './agent.js';
import { isNodeValue, NODE_BRAND, type NodeValue, type NodeSpec } from './node.js';
import { SUBGRAPH_CHILD, SUBGRAPH_BUNDLE } from './subgraph.js';
import type { GraphBundle } from '../authoring/bundle-schema.js';
import type { CapabilityCeiling } from '../tools/registry.js';
import { GraphSpecError } from './errors.js';
import {
  toWireInputs,
  toWireOutputs,
  validateChildInterface,
  type GraphInputSpec,
  type GraphOutputSpec,
} from './interface.js';
import { isDefinedTool, type DefinedTool } from '../tools/define-tool.js';

/** Agent definitions referenced by a facade-authored graph, for `run()`. */
const graphAgents = new WeakMap<Graph, AgentRegistryConfig[]>();

/** Tool implementations referenced inline by a facade-authored graph, for `run()`. */
const graphTools = new WeakMap<Graph, DefinedTool[]>();

/** Child graphs referenced by `subgraph()` values in a facade-authored graph, for `run()`. */
const graphChildren = new WeakMap<Graph, Graph[]>();

/** Capability ceilings declared by embedded bundles, keyed by subgraph id, for `run()`. */
const graphCeilings = new WeakMap<Graph, Record<string, CapabilityCeiling>>();

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

/**
 * Retrieve the child graphs a facade-authored graph embeds via `subgraph()`
 * values (empty if none). Keyed on the parent graph's object identity like
 * {@link agentsForGraph}: a serialized-and-reloaded parent carries only the
 * `subgraph_id` wire references, and the children must be supplied through
 * `loadGraph` explicitly.
 */
export function graphsForGraph(graph: Graph): Graph[] {
  return graphChildren.get(graph) ?? [];
}

/**
 * Retrieve the capability ceilings a facade-authored graph carries for its
 * embedded bundles (empty if none), keyed by subgraph id. Derived from each
 * bundle manifest's `requires`; `run()` threads them to the runner so a
 * bundle child cannot use more than it declared.
 */
export function ceilingsForGraph(graph: Graph): Record<string, CapabilityCeiling> {
  return graphCeilings.get(graph) ?? {};
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
  /**
   * The graph's public interface: memory keys it expects seeded, as Zod
   * schemas (or raw JSON Schema, or full declaration entries). Serialized
   * to JSON Schema on the wire; validated at subgraph boundaries.
   */
  inputs?: Record<string, GraphInputSpec>;
  /** Memory keys the graph produces. Same authoring forms as `inputs`. */
  outputs?: Record<string, GraphOutputSpec>;
}

export { GraphSpecError } from './errors.js';

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
  graph(value: Graph): void;
  bundle(value: GraphBundle): void;
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

  // Strip the brands FIRST: object spread copies symbol keys, so a still-
  // branded `rest` would make resolveRefs treat the whole config as a node
  // reference and collapse it to its id — and a child Graph left in place
  // would be recursed into and mangled. The child graph is collected for
  // run()'s loadGraph auto-wiring; only its id string sits in the config.
  const { [NODE_BRAND]: _brand, [SUBGRAPH_CHILD]: childGraph, [SUBGRAPH_BUNDLE]: bundleRef, agent: agentRef, reads, writes, ...rest } =
    input as NodeSpec & { [NODE_BRAND]?: true; [SUBGRAPH_CHILD]?: Graph; [SUBGRAPH_BUNDLE]?: GraphBundle } & Record<string, unknown>;

  const config = resolveRefs(rest, collect) as Record<string, unknown>;

  if (bundleRef !== undefined) collect.bundle(bundleRef);
  if (childGraph !== undefined) {
    collect.graph(childGraph);
    // Hard-error wiring validation against the child's declared interface:
    // the manifest is the type signature, the mapping is the call. A child
    // without a declared interface validates nothing.
    validateChildInterface(
      childGraph,
      String(config.id ?? '(unnamed)'),
      (config.subgraphConfig ?? {}) as { inputMapping?: Record<string, string>; outputMapping?: Record<string, string> },
    );
  }
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
  const collectedGraphs = new Set<Graph>();
  const collectedBundles = new Set<GraphBundle>();
  const collect: RefCollector = {
    agent: (a) => { collectedAgents.add(a); },
    tool: (t) => { collectedTools.add(t); },
    graph: (child) => { collectedGraphs.add(child); },
    bundle: (b) => { collectedBundles.add(b); },
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
    ...(spec.inputs ? { inputs: toWireInputs(spec.inputs) } : {}),
    ...(spec.outputs ? { outputs: toWireOutputs(spec.outputs) } : {}),
  });

  // Deserialized bundles carry their closure as data (no identity stashes),
  // so fold their agents and child graphs into this graph's stashes. A
  // LOCALLY assembled bundle keeps its original graph objects, whose stashes
  // the run-time closure walk already discovers — merging its wire agents
  // too would register the same definitions twice in two casings.
  const bundleAgents: AgentRegistryConfig[] = [];
  const ceilings: Record<string, CapabilityCeiling> = {};
  for (const b of collectedBundles) {
    // Every bundle declares a capability ceiling from its manifest —
    // uniformly for local and deserialized bundles. For an honestly
    // generated bundle the ceiling equals actual usage; it bites when a
    // manifest under-declares what the graph tries to use.
    ceilings[b.graph.id] = {
      tools: b.manifest.requires.tools.map((t) => t.name),
      mcpServers: b.manifest.requires.mcp_servers.map((s) => s.id),
    };
    const hasLocalStashes =
      agentsForGraph(b.graph).length > 0 ||
      graphsForGraph(b.graph).length > 0 ||
      toolsForGraph(b.graph).length > 0;
    if (hasLocalStashes) continue;
    bundleAgents.push(...(b.agents as unknown as AgentRegistryConfig[]));
    for (const childOfBundle of b.graphs) collectedGraphs.add(childOfBundle);
  }
  if (Object.keys(ceilings).length > 0) {
    graphCeilings.set(built, ceilings);
  }

  if (collectedAgents.size > 0 || bundleAgents.length > 0) {
    // Two DISTINCT agent() values pinned to the same id would race in the
    // run registry (last registration wins, silently). Same-value reuse
    // across nodes is fine — the Set already deduped by identity.
    // toRegistryConfig also surfaces tool() references carried on agent
    // specs, so agent-level inline tools land in the same stash.
    const facadeConfigs = [...collectedAgents].map((value) => toRegistryConfig(value, collect.tool));
    const byId = new Map<string, number>();
    for (const config of facadeConfigs) {
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

    // Bundle agents merge by id with JSON dedupe: the same definition
    // arriving from two bundle objects is harmless; a conflicting one is not.
    const configs: AgentRegistryConfig[] = [];
    const mergedById = new Map<string, string>();
    for (const config of [...facadeConfigs, ...bundleAgents]) {
      const id = (config as { id?: string }).id ?? '';
      const serialized = JSON.stringify(config);
      const prior = mergedById.get(id);
      if (prior === undefined) {
        mergedById.set(id, serialized);
        configs.push(config);
      } else if (prior !== serialized) {
        throw new GraphSpecError(
          `Agent id "${id}" is defined differently by an inline agent() and a bundle (or two ` +
            'bundles) in this graph — give each definition its own id',
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

  if (collectedGraphs.size > 0) {
    // Two DISTINCT child graphs sharing an id would collide in loadGraph
    // resolution (one silently shadows the other). Same-child reuse across
    // several subgraph nodes is fine — the Set already deduped by identity.
    const byId = new Map<string, Graph>();
    for (const child of collectedGraphs) {
      const existing = byId.get(child.id);
      if (existing && existing !== child) {
        throw new GraphSpecError(
          `Two distinct child graphs share the id "${child.id}" — reuse the same graph() value ` +
            'across subgraph nodes, or give each child its own id',
        );
      }
      byId.set(child.id, child);
    }
    graphChildren.set(built, [...collectedGraphs]);
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
