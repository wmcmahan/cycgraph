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

import type { GraphNode } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import type { TaintRegistry } from '../types/state.js';

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
export class SecurityPolicyViolationError extends Error {
  readonly node_id: string;
  readonly sensitivity?: string[];
  constructor(node_id: string, reason: string, sensitivity?: string[]) {
    super(reason);
    this.name = 'SecurityPolicyViolationError';
    this.node_id = node_id;
    this.sensitivity = sensitivity;
  }
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
