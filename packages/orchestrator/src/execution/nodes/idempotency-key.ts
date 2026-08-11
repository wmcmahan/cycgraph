/**
 * Canonical idempotency key for action envelopes emitted by node
 * executors: one `(node, workflow iteration, retry attempt)` triple per
 * action. Every executor uses this helper so the format cannot drift
 * between executors.
 *
 * Executors that emit multiple actions for one execution append a
 * discriminator suffix (e.g. the subgraph executor's `:wait` action).
 *
 * NOT to be confused with the `MemoryWriter` write-deduplication key
 * (`run_id:node_id:iteration` — see `reflection.ts`), which deliberately
 * excludes the attempt so a retried reflection write dedupes against the
 * first attempt's persisted facts.
 *
 * @module execution/nodes/idempotency-key
 */

import type { GraphNode } from '../../graph/graph.js';
import type { NodeExecutorContext } from './context.js';

/** Build the canonical action idempotency key for a node execution. */
export function nodeIdempotencyKey(
  node: GraphNode,
  ctx: NodeExecutorContext,
  attempt: number,
): string {
  return `${node.id}:${ctx.state.iteration_count}:${attempt}`;
}
