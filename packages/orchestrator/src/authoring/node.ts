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
import {
  agentOutputs,
  synthesizerOutputs,
  toolOutputs,
  withOutputs,
  type AgentOutputs,
  type SynthesizerOutputs,
  type ToolOutputs,
} from './outputs.js';

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

/**
 * Fields every node accepts whatever its type: where it sits and how it
 * behaves under failure. Each node-type spec extends this, so resilience and
 * cost controls are available from every authoring entry point rather than
 * only from `node()`.
 *
 * `writes` is deliberately absent. Node types whose executor owns its result
 * keys imply those grants, and their specs do not accept a declaration that
 * could disagree with what the executor writes.
 */
export interface NodeCommon {
  /** Node id in the topology. */
  id: string;
  /** Memory keys this node may read. Omitted → least privilege. */
  reads?: string[];
  /** Retry and backoff behaviour. */
  failurePolicy?: NodeConfig['failurePolicy'];
  /** Per-node token and cost caps. Breaching one fails the node without retry. */
  budget?: NodeConfig['budget'];
  /** Whether this node pushes a compensating action for saga rollback. */
  requiresCompensation?: boolean;
  /** Arbitrary metadata for tooling. */
  metadata?: Record<string, unknown>;
}

/** Authoring spec for a node: placement + grants + agent reference. */
export type NodeSpec = Omit<WidenRefs<NodeConfig>, 'type' | 'readKeys' | 'writeKeys'> & {
  /** Node type. Defaults to `'agent'` when an `agent` is given. */
  type?: NodeConfig['type'];
  /** The agent that runs here: an `agent()` value, or a registry id string. */
  agent?: AgentValue | string;
  /**
   * Additional memory keys this node may read. Omitted → least privilege.
   *
   * `goal` and `constraints` are state fields rather than memory keys and
   * reach every node whatever this says, so listing them grants nothing.
   */
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
 * The output keys a node of this spec's type writes, named so they can be
 * read without retyping the string. See authoring/outputs.ts.
 */
export type OutputsFor<S extends NodeSpec> =
  S['type'] extends 'tool' ? ToolOutputs
    : S['type'] extends 'synthesizer' ? SynthesizerOutputs & AgentOutputs
      : S['type'] extends 'agent' | undefined ? AgentOutputs
        : unknown;

/**
 * Author a graph node. `type` defaults to `'agent'` when an `agent` is
 * given; every other node type names itself (`'supervisor'`, `'tool'`, …).
 *
 * The returned value carries the keys a reader downstream needs to name:
 *
 * - Its own output keys — `.result` on a tool node, `.synthesis` on a
 *   synthesizer — which executor machinery derives from the node's id.
 * - Its declared `writes`, kept at the literal type it was given, so a
 *   downstream `reads: [draft.writes]` is checked rather than retyped.
 *
 * The two differ in strength. An output key is written by the executor and is
 * there whenever the node succeeds. `writes` is a *grant*: the agent may write
 * that key, may write nothing, or may have its text routed to `${id}_output`
 * when no write key claims it. Both name where a value would be, neither
 * promises one exists.
 */
export function node<const S extends NodeSpec>(spec: S): NodeValue & OutputsFor<S> & Pick<S, 'writes'> {
  const value: NodeValue = { ...spec, [NODE_BRAND]: true };
  const id = spec.id;

  if (spec.type === 'tool') return withOutputs(value, toolOutputs(id)) as unknown as NodeValue & OutputsFor<S> & Pick<S, 'writes'>;
  if (spec.type === 'synthesizer') {
    return withOutputs(value, { ...synthesizerOutputs(id), ...agentOutputs(id) }) as unknown as NodeValue & OutputsFor<S> & Pick<S, 'writes'>;
  }
  if (spec.type === undefined || spec.type === 'agent') {
    return withOutputs(value, agentOutputs(id)) as unknown as NodeValue & OutputsFor<S> & Pick<S, 'writes'>;
  }
  return value as unknown as NodeValue & OutputsFor<S> & Pick<S, 'writes'>;
}
