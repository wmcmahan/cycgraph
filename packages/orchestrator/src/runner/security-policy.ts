/**
 * Security Policy Port
 *
 * A taint-aware enforcement hook consulted by the {@link GraphRunner} BEFORE a
 * node executes. The engine owns the enforcement MECHANISM (block the run, or
 * pause it for human approval); the host application owns the POLICY (what
 * counts as a "sensitive" node, and what to do when untrusted data reaches it).
 *
 * This is the same injection pattern as the other runner ports
 * (`factSanitizer`, `rateLimiter`, `memoryRetriever`): the engine defines the
 * type, the caller provides the implementation. It lets the platform enforce a
 * "untrusted data + sensitive action ⇒ approval/deny" rule on EVERY graph
 * automatically — the graph author does not have to wire an approval node.
 *
 * Enforcement is PRE-execution by design: an agent's tool calls run inside its
 * own LLM loop, so the only point at which the runner can *prevent* untrusted
 * data from reaching an egress/secret tool is before the node runs at all.
 *
 * @module runner/security-policy
 */

import { v4 as uuidv4 } from 'uuid';
import type { GraphNode } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import type { TaintRegistry } from '../types/state.js';
import { getTaintRegistry } from '../utils/taint.js';
import { createLogger } from '../utils/logger.js';
import { CycgraphError } from '../errors.js';

const logger = createLogger('runner.security-policy');

/** What the policy decided to do about a (tainted, sensitive) node. */
export type SecurityPolicyEffect = 'allow' | 'monitor' | 'block' | 'require_approval';

/** Read-only context handed to the policy for a single node about to execute. */
export interface SecurityPolicyContext {
  /** The node that is about to execute. */
  node: Readonly<GraphNode>;
  /** Current workflow state (read-only). */
  state: Readonly<WorkflowState>;
  /**
   * The subset of the node's READABLE keys that are currently tainted. Always
   * non-empty when the policy is consulted — the runner skips the policy
   * entirely for nodes that read no untrusted data.
   */
  tainted_read_keys: string[];
}

/** The policy's decision for one node. */
export interface SecurityPolicyDecision {
  /** What to do. `allow` (and an undefined decision) let the node run normally. */
  effect: SecurityPolicyEffect;
  /** Human-readable explanation, surfaced in the approval gate / failure. */
  reason?: string;
  /** Sensitivity labels that triggered the decision (e.g. `['egress', 'tool:fetch']`). */
  sensitivity?: string[];
  /** Identifier of the policy rule that matched (for audit). */
  rule_id?: string;
  /** Override the human-facing approval prompt (only used for `require_approval`). */
  prompt?: string;
}

/**
 * A security policy: given a node about to execute and the untrusted data it
 * can read, decide whether to allow, monitor, block, or gate it.
 *
 * MUST be synchronous and side-effect free — it is called inside the runner's
 * hot loop and its return value is the only channel back to the engine.
 */
export type SecurityPolicy = (ctx: SecurityPolicyContext) => SecurityPolicyDecision | undefined;

/**
 * Thrown when a policy returns `block`. Routed through the runner's normal
 * failure path, so the run ends `failed` with this message (fail-closed).
 */
export class SecurityPolicyViolationError extends CycgraphError {
  readonly node_id: string;
  readonly sensitivity?: string[];
  constructor(node_id: string, reason: string, sensitivity?: string[]) {
    super(reason);
    this.name = 'SecurityPolicyViolationError';
    this.node_id = node_id;
    this.sensitivity = sensitivity;
  }
}

/** Payload of the runner's `security:policy` audit event (every non-`allow` decision). */
export interface SecurityPolicyEventPayload {
  run_id: string;
  node_id: string;
  effect: 'monitor' | 'block' | 'require_approval';
  sensitivity?: string[];
  tainted_keys: string[];
  reason?: string;
  rule_id?: string;
  timestamp: number;
}

/**
 * Consult the security policy for a node about to execute.
 *
 * Returns a `request_human_input` gate action to inject (pausing the run
 * for approval), or `undefined` to let the node run normally. Throws
 * {@link SecurityPolicyViolationError} when the policy decision is `block`
 * (the run's failure path turns this into a fail-closed `workflow:failed`).
 *
 * Only consulted for nodes that read tainted data; a node reading nothing
 * untrusted is always allowed without invoking the policy.
 */
export function evaluateSecurityPolicy(args: {
  node: GraphNode;
  state: WorkflowState;
  policy: SecurityPolicy;
  /** Surfaces every non-allow decision so the host can audit it durably. */
  emitPolicyEvent: (payload: SecurityPolicyEventPayload) => void;
}): Action | undefined {
  const { node, state, policy } = args;

  // A prior human approval for this node (recorded on resume) lets it run
  // exactly once. The flag persists for the run, so a node revisited in a
  // loop after approval is not re-gated — a known v1 limitation.
  const approved = (state.memory._policy_approved ?? {}) as Record<string, boolean>;
  if (approved[node.id]) return undefined;

  const registry = getTaintRegistry(state.memory);
  const taintedReadKeys = readableTaintedKeys(node, registry);
  if (taintedReadKeys.length === 0) return undefined;

  const decision = policy({
    node,
    state,
    tainted_read_keys: taintedReadKeys,
  });
  if (!decision || decision.effect === 'allow') return undefined;

  args.emitPolicyEvent({
    run_id: state.run_id,
    node_id: node.id,
    effect: decision.effect,
    sensitivity: decision.sensitivity,
    tainted_keys: taintedReadKeys,
    reason: decision.reason,
    rule_id: decision.rule_id,
    timestamp: Date.now(),
  });

  if (decision.effect === 'monitor') {
    logger.warn('security_policy_flagged', {
      run_id: state.run_id,
      node_id: node.id,
      sensitivity: decision.sensitivity,
      tainted_keys: taintedReadKeys,
      reason: decision.reason,
    });
    return undefined;
  }

  if (decision.effect === 'block') {
    throw new SecurityPolicyViolationError(
      node.id,
      decision.reason
        ?? `Blocked by security policy: untrusted data reaching a sensitive action at node "${node.id}"`,
      decision.sensitivity,
    );
  }

  // require_approval → inject an approval gate BEFORE the node runs. Tagged
  // `policy_gate` so the resume path re-enters this node (rather than
  // advancing past it) once a human approves.
  logger.info('security_policy_gated', {
    run_id: state.run_id,
    node_id: node.id,
    sensitivity: decision.sensitivity,
    tainted_keys: taintedReadKeys,
  });
  return {
    id: uuidv4(),
    idempotency_key: `policy_gate:${node.id}:${state.iteration_count}`,
    type: 'request_human_input',
    payload: {
      waiting_for: 'human_approval',
      pending_approval: {
        node_id: node.id,
        policy_gate: true,
        prompt_message: decision.prompt
          ?? `Security policy: node "${node.id}" uses untrusted data to perform a sensitive action. Approve to proceed.`,
        review_data: {
          reason: decision.reason,
          sensitivity: decision.sensitivity,
          rule_id: decision.rule_id,
          tainted_keys: taintedReadKeys,
        },
      },
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt: 1,
    },
  };
}

/**
 * Compute which of a node's readable keys are tainted, given the taint registry.
 *
 * - `read_keys` containing `'*'` ⇒ every tainted key is readable.
 * - Dot-notation read keys (`user.name`) match on their top-level segment.
 */
export function readableTaintedKeys(
  node: Readonly<GraphNode>,
  registry: TaintRegistry,
): string[] {
  const taintedKeys = Object.keys(registry);
  if (taintedKeys.length === 0) return [];
  const readKeys = node.read_keys ?? [];
  if (readKeys.includes('*')) return taintedKeys;
  const top = new Set(readKeys.map((k) => k.split('.')[0]));
  return taintedKeys.filter((k) => top.has(k));
}
