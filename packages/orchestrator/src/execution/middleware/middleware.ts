/**
 * Graph Runner Middleware
 *
 * Provides extension points for the GraphRunner execution loop.
 * Middleware hooks run synchronously in registration order and
 * can observe, transform, or short-circuit node execution.
 *
 * @module execution/middleware/middleware
 */

import type { GraphNode, Graph } from '../../graph/graph.js';
import type { WorkflowState, Action } from '../../state/state.js';

/**
 * Read-only context passed to every middleware hook.
 */
export interface MiddlewareContext {
  /** The node being executed. */
  node: GraphNode;
  /** Current workflow state (read-only snapshot). */
  state: Readonly<WorkflowState>;
  /** The graph definition (read-only). */
  graph: Readonly<Graph>;
  /** Current iteration count. */
  iteration: number;
}

/**
 * Result from a `beforeNodeExecute` hook.
 */
export interface BeforeNodeResult {
  /** If set, skip node execution and use this action instead. */
  shortCircuit?: Action;
}

/**
 * Middleware interface for extending GraphRunner behavior.
 *
 * All hooks are optional. Middleware instances are called in
 * registration order. Errors thrown by middleware propagate to
 * the runner's error handling (same as node errors).
 */
export interface GraphRunnerMiddleware {
  /**
   * Called before a node executes. Return a `shortCircuit` action
   * to skip execution entirely (e.g. for caching).
   */
  beforeNodeExecute?(ctx: MiddlewareContext): Promise<BeforeNodeResult | void>;

  /**
   * Called after a node executes, before the action is reduced.
   * May return a transformed action or void to keep the original.
   */
  afterNodeExecute?(ctx: MiddlewareContext, action: Action): Promise<Action | void>;

  /**
   * Called after the action has been reduced into state.
   * Observational only — the returned value is ignored.
   */
  afterReduce?(ctx: MiddlewareContext, action: Action, newState: Readonly<WorkflowState>): Promise<void>;

  /**
   * Called before advancing to the next node. Return a node ID
   * to override routing, or void to keep the default.
   */
  beforeAdvance?(ctx: MiddlewareContext, nextNodeId: string): Promise<string | void>;
}
