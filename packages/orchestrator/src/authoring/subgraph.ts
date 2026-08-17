/**
 * subgraph() — compose a child graph into a parent topology
 *
 * Returns a {@link NodeValue} whose config carries only the child's id, so
 * the compiled wire is identical to a hand-authored `subgraph` node. A child
 * `Graph` value in scope rides on a brand symbol outside the config, where
 * `graph()` collects it so `run()` can auto-wire `loadGraph` and register
 * the child's agents.
 *
 * @module authoring/subgraph
 */

import type { Graph } from '../graph/graph.js';
import { isGraphBundle, type GraphBundle } from './bundle-schema.js';
import { withMappedOutputs, type MappedOutputsFor } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/**
 * Brand carrying an in-scope child `Graph` on a subgraph node value.
 * Lives outside `subgraphConfig` so the deep-resolve walk never recurses
 * into a compiled graph object. @internal
 */
export const SUBGRAPH_CHILD: unique symbol = Symbol('cycgraph.authoring.subgraph-child');

/**
 * Brand carrying a {@link GraphBundle} on a subgraph node value, so
 * `graph()` can fold the bundle's agents and child-graph closure into the
 * composition. @internal
 */
export const SUBGRAPH_BUNDLE: unique symbol = Symbol('cycgraph.authoring.subgraph-bundle');

/** Authoring spec for {@link subgraph}: placement, grants, and memory mappings. */
export interface SubgraphSpec extends NodeCommon {
  /** Parent memory key(s) this node may write. */
  writes?: string | string[];
  /** Parent key → child key seeding of the child's isolated memory. */
  inputs?: Record<string, string>;
  /** Child key → parent key mapping of results back to the parent. */
  outputs?: Record<string, string>;
  /** Maximum iterations for the child workflow. */
  maxIterations?: number;
}

/**
 * Author a subgraph node: embed `child` in the parent topology at `spec.id`.
 *
 * @param child - A `graph()` value (auto-wired by `run()`) or a graph id
 *   string (resolved by the caller's `loadGraph`).
 * @param spec - Placement, grants, and the input/output memory mappings.
 */
export function subgraph<const S extends SubgraphSpec>(
  child: Graph | GraphBundle | string,
  spec: S,
): NodeValue & MappedOutputsFor<S> {
  const { inputs, outputs, maxIterations, ...placement } = spec;
  const bundleRef = typeof child !== 'string' && isGraphBundle(child) ? child : undefined;
  const childGraph = typeof child === 'string' ? undefined : (bundleRef?.graph ?? (child as Graph));
  const childId = typeof child === 'string' ? child : childGraph!.id;

  const value = {
    ...placement,
    type: 'subgraph' as const,
    subgraphConfig: {
      subgraphId: childId,
      ...(inputs !== undefined ? { inputMapping: inputs } : {}),
      ...(outputs !== undefined ? { outputMapping: outputs } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    },
    [NODE_BRAND]: true as const,
    ...(childGraph !== undefined ? { [SUBGRAPH_CHILD]: childGraph } : {}),
    ...(bundleRef !== undefined ? { [SUBGRAPH_BUNDLE]: bundleRef } : {}),
  };

  return withMappedOutputs(value as NodeValue, spec.outputs) as NodeValue & MappedOutputsFor<S>;
}
