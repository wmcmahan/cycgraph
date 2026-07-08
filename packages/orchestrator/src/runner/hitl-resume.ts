/**
 * Human-in-the-Loop Resume
 *
 * Pure decision logic for applying a human response to a paused run:
 * builds the `resume_from_human` action, reduces it into state, and
 * computes the follow-up routing (advance past the approval node, route
 * to a rejection branch, cancel, or re-enter a policy-gated node).
 *
 * The owning runner applies the outcome: swap in the returned state,
 * record `resumeAction` in the event log, then fire the returned
 * internal dispatches in order — so event-log replay applies the resume
 * in the same order as the live run.
 *
 * @module runner/hitl-resume
 */

import { v4 as uuidv4 } from 'uuid';
import type { Graph, GraphNode, GraphEdge } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import { rootReducer } from '../reducers/index.js';
import { getNextNode } from './router.js';

/**
 * Human response payload for HITL (Human-in-the-Loop) resume.
 */
export interface HumanResponse {
  /** The reviewer's decision. */
  decision: 'approved' | 'rejected' | 'edited';
  /** Optional freeform response data. */
  data?: unknown;
  /** Optional memory updates to apply on resume. */
  memory_updates?: Record<string, unknown>;
}

/** Result of applying a human response — see module doc for how to apply it. */
export interface HumanResponseOutcome {
  /** State after the resume action (and any policy-approval flag) is applied. */
  state: WorkflowState;
  /** The `resume_from_human` action, for durable event-log recording. */
  resumeAction: Action;
  /** Internal dispatches to fire AFTER recording the action, in order. */
  dispatches: Array<{ type: '_advance' | '_cancel'; payload?: Record<string, unknown> }>;
}

/**
 * Compute the state transition and follow-up routing for a human response.
 * Pure — no side effects; all effects are described in the returned outcome.
 */
export function computeHumanResponseOutcome(
  response: HumanResponse,
  state: WorkflowState,
  graph: Graph,
  edgeMap: Map<string, GraphEdge[]>,
  nodeMap: Map<string, GraphNode>,
  routingOptions: { strict_taint: boolean },
): HumanResponseOutcome {
  const pendingApproval = state.memory._pending_approval as {
    node_id?: string;
    rejection_node_id?: string;
    policy_gate?: boolean;
    subgraph_node_id?: string;
  } | undefined;

  // Create and apply resume action
  const resumeAction: Action = {
    id: uuidv4(),
    idempotency_key: `resume:${state.run_id}:${Date.now()}`,
    type: 'resume_from_human',
    payload: {
      decision: response.decision,
      response: response.data,
      memory_updates: response.memory_updates,
    },
    metadata: {
      node_id: pendingApproval?.node_id || 'unknown',
      timestamp: new Date(),
      attempt: 1,
    },
  };

  let nextState = rootReducer(state, resumeAction);
  const dispatches: HumanResponseOutcome['dispatches'] = [];

  // Nested subgraph approval: the decision belongs to the CHILD run, not the
  // parent. `resume_from_human` already recorded human_decision/human_response
  // in memory; re-enter the subgraph node (current_node never advanced) so its
  // executor forwards the decision and continues the child. Do NOT advance or
  // cancel the parent here.
  if (pendingApproval?.subgraph_node_id) {
    return { state: nextState, resumeAction, dispatches };
  }

  // Handle rejection routing
  if (response.decision === 'rejected') {
    if (pendingApproval?.rejection_node_id) {
      const rejectionNode = graph.nodes.find(n => n.id === pendingApproval.rejection_node_id);
      if (rejectionNode) {
        dispatches.push({ type: '_advance', payload: { node_id: rejectionNode.id } });
        return { state: nextState, resumeAction, dispatches };
      }
    }
    // No rejection branch configured: the human declined the action, so the
    // run must NOT proceed to the gated node. Terminate it (cancelled) rather
    // than leaving it stalled with nowhere to advance.
    dispatches.push({ type: '_cancel' });
  } else if (pendingApproval?.policy_gate && pendingApproval.node_id) {
    // Approved a SECURITY-POLICY gate. Unlike a graph-authored approval node,
    // the gated node has NOT executed yet — the policy held it before it ran.
    // Record the approval and re-enter the SAME node (do not advance) so it
    // now runs. `evaluateSecurityPolicy` sees the flag and lets it through once.
    const approved = {
      ...((nextState.memory._policy_approved as Record<string, boolean> | undefined) ?? {}),
      [pendingApproval.node_id]: true,
    };
    nextState = {
      ...nextState,
      memory: { ...nextState.memory, _policy_approved: approved },
    };
  } else {
    // Approved: advance to the next node from the approval node.
    const approvalNode = graph.nodes.find(n => n.id === pendingApproval?.node_id);
    if (approvalNode) {
      const nextNode = getNextNode(edgeMap, nodeMap, approvalNode, nextState, routingOptions);
      if (nextNode) {
        dispatches.push({ type: '_advance', payload: { node_id: nextNode.id } });
      }
    }
  }

  return { state: nextState, resumeAction, dispatches };
}
