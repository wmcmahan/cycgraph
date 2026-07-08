/**
 * Approval Gate Executor (Human-in-the-Loop)
 *
 * Pauses workflow execution by emitting a `request_human_input` action.
 * The runner transitions the workflow to `waiting` status and persists
 * the review data until a human approves or rejects.
 *
 * @module runner/node-executors/approval
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';

const logger = createLogger('runner.node.approval');

/**
 * Execute an approval gate node.
 *
 * Filters memory by `review_keys` and emits a `request_human_input`
 * action containing the review data and timeout configuration.
 *
 * @param node - Approval node with `approval_config`.
 * @param stateView - Filtered state view for the reviewer.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `request_human_input` action that pauses the workflow.
 * @throws If `approval_config` is missing.
 */
export async function executeApprovalNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.approval_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'approval', 'approval_config');
  }

  logger.info('approval_gate_executing', { node_id: node.id, approval_type: config.approval_type });

  // Filter memory to only the keys the reviewer should see
  let reviewData: Record<string, unknown> = {};
  if (config.review_keys.includes('*')) {
    reviewData = { ...stateView.memory };
  } else {
    for (const key of config.review_keys) {
      if (key in stateView.memory) {
        reviewData[key] = stateView.memory[key];
      }
    }
  }

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'request_human_input',
    payload: {
      waiting_for: 'human_approval',
      timeout_ms: config.timeout_ms,
      pending_approval: {
        node_id: node.id,
        prompt_message: config.prompt_message,
        review_data: reviewData,
        rejection_node_id: config.rejection_node_id,
      },
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
    },
  };
}
