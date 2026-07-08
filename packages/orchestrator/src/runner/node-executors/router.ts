/**
 * Router Node Executor
 *
 * A pass-through node that emits a no-op action. The actual routing
 * logic is handled by edge condition evaluation in `getNextNode()`.
 *
 * @module runner/node-executors/router
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';

const logger = createLogger('runner.node.router');

/**
 * Execute a router node (conditional branching).
 *
 * The router itself does not modify state — it exists as a named
 * decision point whose outgoing edge conditions determine the next
 * node via `getNextNode()`.
 *
 * @param node - Router node.
 * @param _stateView - State view (unused — routing uses edge conditions).
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns No-op `update_memory` action with empty updates.
 */
export async function executeRouterNode(
  node: GraphNode,
  _stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  logger.info('router_evaluating', { node_id: node.id });

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: {
      updates: {},
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
    },
  };
}
