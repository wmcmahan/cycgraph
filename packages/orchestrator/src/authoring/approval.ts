/**
 * approval() — pause the run until a human decides
 *
 * Nothing to lead with: the node is the gate itself. Execution stops, the run
 * persists as `waiting`, and it continues when `applyHumanResponse` arrives.
 *
 * @module authoring/approval
 */

import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link approval}. */
export interface ApprovalSpec extends NodeCommon {
  /** Memory key(s) the decision may write. */
  writes?: string | string[];
  /** Message shown to the reviewer. */
  prompt?: string;
  /** Memory keys the reviewer sees. */
  reviewKeys?: string[];
  /** How long before the gate auto-rejects. */
  timeoutMs?: number;
  /** Where a rejection routes. Without it, a rejected run fails. */
  onReject?: NodeValue | string;
}

/**
 * Author an `approval` node.
 *
 * @param spec - Placement, reviewer prompt, and rejection routing.
 */
export function approval(spec: ApprovalSpec): NodeValue {
  const { prompt, reviewKeys, timeoutMs, onReject, ...placement } = spec;

  return {
    ...placement,
    type: 'approval' as const,
    approvalConfig: {
      ...(prompt !== undefined ? { promptMessage: prompt } : {}),
      ...(reviewKeys !== undefined ? { reviewKeys } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(onReject !== undefined ? { rejectionNodeId: onReject } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue;
}
