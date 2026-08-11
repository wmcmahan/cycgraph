/**
 * node() — placement of work in the graph topology
 *
 * A node value is WHERE something runs: a topology id (what edges name),
 * state grants (`reads`/`writes` — the authoritative permission in the
 * engine), and which agent runs there. Agent references are {@link AgentValue}s
 * placed either on the `agent` field or in any `…AgentId` config field
 * (supervisor brains, evolution candidates, evaluators, voters); `graph()`
 * resolves them to registry ids at compile time.
 *
 * The returned value exposes the spec's own properties (`id` above all), so
 * topology references can be passed by value: `edges: [{ from: research,
 * to: write }]`, `managedNodes: [research, write]`, `startNode: research`.
 * Node ids are yours — unlike agent ids, which belong to the registry — so
 * the value shows them.
 *
 * Like `agent()`, `node()` returns an inert value — nothing is validated
 * against the wire schema or registered until `graph()` compiles it.
 *
 * @module authoring/node
 */

import type { NodeConfig } from '../graph/graph.js';
import type { AgentValue } from './agent.js';

/** Brand marking a value produced by {@link node}. */
export const NODE_BRAND: unique symbol = Symbol('cycgraph.authoring.node');

/**
 * Widen agent-reference and node-reference fields, recursively through
 * config blocks: `…agentId` / `…AgentIds` fields also accept
 * {@link AgentValue}s, and `managedNodes` also accepts {@link NodeValue}s.
 * The runtime counterpart is `graph()`'s deep resolution of branded values.
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
 * A node value: the spec's own properties plus the facade brand, compiled
 * by `graph()`. Pass it wherever a node is named — `nodes`, edge
 * `from`/`to`, `startNode`/`endNodes`, `managedNodes`.
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
