/**
 * node() — placement of work in the graph topology
 *
 * A node value is where something runs: a topology id, state grants
 * (`reads`/`writes`, the authoritative permission in the engine), and which
 * agent runs there. {@link AgentValue}s may be placed on `agent` or in any
 * `…AgentId` config field; `graph()` resolves them to registry ids.
 *
 * The value exposes the spec's own properties, so topology references can be
 * passed by value: `edges: [{ from: research, to: write }]`.
 *
 * The value is inert: nothing is validated or registered until `graph()`
 * compiles it.
 *
 * @module authoring/node
 */

import type { NodeConfig } from '../graph/graph.js';
import type { AgentValue } from './agent.js';

/** Brand marking a value produced by {@link node}. */
export const NODE_BRAND: unique symbol = Symbol('cycgraph.authoring.node');

/**
 * Widen reference fields recursively through config blocks: `…agentId` /
 * `…AgentIds` also accept {@link AgentValue}s, `managedNodes` also accepts
 * {@link NodeValue}s. Resolved at runtime by `graph()`.
 */
export type WidenRefs<T> = T extends (infer U)[]
  ? WidenRefs<U>[]
  : T extends object
    ? {
        [K in keyof T]: K extends 'agentId' | `${string}AgentId`
          ? T[K] | AgentValue
          : K extends `${string}AgentIds`
            ? T[K] | (string | AgentValue)[]
            : K extends 'managedNodes'
              ? T[K] | (string | NodeValue)[]
              : WidenRefs<T[K]>;
      }
    : T;

/** Authoring spec for a node: placement + grants + agent reference. */
export type NodeSpec = Omit<WidenRefs<NodeConfig>, 'type' | 'readKeys' | 'writeKeys'> & {
  /** Node type. Defaults to `'agent'` when an `agent` is given. */
  type?: NodeConfig['type'];
  /** The agent that runs here: an `agent()` value, or a registry id string. */
  agent?: AgentValue | string;
  /** Memory keys this node may read. Omitted → least privilege (`goal`/`constraints`). */
  reads?: string[];
  /** Memory key(s) this node may write. */
  writes?: string | string[];
};

/**
 * A node value: the spec's own properties plus the facade brand. Pass it
 * wherever a node is named — `nodes`, edge `from`/`to`, `startNode`,
 * `endNodes`, `managedNodes`.
 */
export type NodeValue = NodeSpec & { readonly [NODE_BRAND]: true };

/** Whether a value is a {@link NodeValue}. */
export function isNodeValue(value: unknown): value is NodeValue {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[NODE_BRAND] === true;
}

/**
 * Author a graph node. `type` defaults to `'agent'` when an `agent` is
 * given; every other node type names itself (`'supervisor'`, `'tool'`, …).
 */
export function node(spec: NodeSpec): NodeValue {
  return { ...spec, [NODE_BRAND]: true };
}
