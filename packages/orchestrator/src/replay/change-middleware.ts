/**
 * Execution-time changes
 *
 * The changes that cannot be applied by rewriting state or overlaying config,
 * because they describe what happens *while* the tail runs: forcing a route,
 * substituting a node's output, substituting a tool result.
 *
 * All three ride the hooks the runner already exposes — `beforeNodeExecute`
 * short-circuits a node with an action, `beforeAdvance` overrides routing —
 * so nothing here reaches into the engine.
 *
 * @module replay/change-middleware
 */

import { v4 as uuidv4 } from 'uuid';
import type { Action } from '../state/state.js';
import type { GraphRunnerMiddleware, MiddlewareContext, BeforeNodeResult } from '../execution/middleware/middleware.js';
import type { Change } from './mutations.js';

/** A node output or route that a change stood in for. */
export interface AppliedChange {
  nodeId: string;
  kind: 'output' | 'tool' | 'route';
  detail: string;
}

/** The middleware plus what it ended up applying. */
export interface ChangeMiddleware {
  middleware: GraphRunnerMiddleware;
  readonly applied: AppliedChange[];
}

/** Build the action a substituted node is treated as having produced. */
function substituteAction(
  nodeId: string,
  updates: Record<string, unknown>,
  iteration: number,
): Action {
  return {
    id: uuidv4(),
    // Matches the canonical `(node, iteration, attempt)` form so the runner's
    // duplicate detection treats a substituted node exactly like a real one.
    idempotency_key: `${nodeId}:${iteration}:1`,
    type: 'update_memory',
    payload: { updates },
    metadata: { node_id: nodeId, timestamp: new Date(), attempt: 1 },
  };
}

/**
 * Apply the execution-time changes in a fork.
 *
 * @param changes Already conflict-checked, so at most one change decides any
 *   one node's output and at most one redirects any one node's exit.
 */
export function createChangeMiddleware(changes: readonly Change[]): ChangeMiddleware {
  const outputs = new Map<string, Record<string, unknown>>();
  const routes = new Map<string, { to: string; once: boolean }>();
  const spentRoutes = new Set<string>();
  const applied: AppliedChange[] = [];

  for (const c of changes) {
    if (c.kind === 'output') outputs.set(c.node_id, c.memory);
    // A tool node writes its result to `<node>_result`; substituting the
    // result is substituting that key.
    if (c.kind === 'tool') outputs.set(c.node_id, { [`${c.node_id}_result`]: c.result });
    if (c.kind === 'route') {
      routes.set(c.from_node_id, { to: c.to_node_id, once: c.once ?? false });
    }
  }

  const middleware: GraphRunnerMiddleware = {
    async beforeNodeExecute(ctx: MiddlewareContext): Promise<BeforeNodeResult | void> {
      const updates = outputs.get(ctx.node.id);
      if (!updates) return;

      applied.push({
        nodeId: ctx.node.id,
        kind: ctx.node.type === 'tool' ? 'tool' : 'output',
        detail: `substituted ${Object.keys(updates).join(', ')}`,
      });
      return { shortCircuit: substituteAction(ctx.node.id, updates, ctx.state.iteration_count) };
    },

    async beforeAdvance(ctx: MiddlewareContext, nextNodeId: string): Promise<string | void> {
      const route = routes.get(ctx.node.id);
      if (!route) return;
      if (route.once && spentRoutes.has(ctx.node.id)) return;

      spentRoutes.add(ctx.node.id);
      applied.push({
        nodeId: ctx.node.id,
        kind: 'route',
        detail: `${nextNodeId} → ${route.to}`,
      });
      return route.to;
    },
  };

  return { middleware, applied };
}

/** True when any change needs the middleware at all. */
export function hasExecutionTimeChanges(changes: readonly Change[]): boolean {
  return changes.some(c => c.kind === 'output' || c.kind === 'tool' || c.kind === 'route');
}
