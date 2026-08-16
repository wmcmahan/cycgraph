/**
 * mapReduce() — fan out over a collection, then fan back in
 *
 * The worker comes first: it is the node each item is run through. `items`
 * names where the collection lives, either a memory path or a literal array.
 * `into` names the synthesizer that folds the results.
 *
 * Named for what it spreads over. `voting` and `evolution` also fan out, over
 * voters and candidates, so the general term would be ambiguous here.
 *
 * Result keys are implied by the node type, so this spec takes no `writes`.
 *
 * @module authoring/map-reduce
 */

import { withOutputs, mapOutputs, type MapOutputs } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link mapReduce}. */
export interface MapReduceSpec extends NodeCommon {
  /**
   * The collection to spread over: a JSONPath into memory, or a literal
   * array. A path resolving above `maxItems` fails the node.
   */
  items: string | unknown[];
  /** Synthesizer node the worker results fan into. */
  into?: NodeValue | string;
  /** Workers in flight at once. */
  concurrency?: number;
  /** Hard cap on items fanned out. */
  maxItems?: number;
  /** What a failing worker does to the node. */
  onError?: 'fail_fast' | 'best_effort';
  /** Per-worker timeout in milliseconds. */
  taskTimeoutMs?: number;
}

/**
 * Author a `map` node.
 *
 * @param worker - The node each item is run through.
 * @param spec - Placement, the collection, and fan-out limits.
 */
export function mapReduce(worker: NodeValue | string, spec: MapReduceSpec): NodeValue & MapOutputs {
  const { items, into, concurrency, maxItems, onError, taskTimeoutMs, ...placement } = spec;

  return withOutputs({
    ...placement,
    type: 'map' as const,
    mapReduceConfig: {
      workerNodeId: worker,
      ...(typeof items === 'string' ? { itemsPath: items } : { staticItems: items }),
      ...(into !== undefined ? { synthesizerNodeId: into } : {}),
      ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(onError !== undefined ? { errorStrategy: onError } : {}),
      ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue, mapOutputs(spec.id));
}
