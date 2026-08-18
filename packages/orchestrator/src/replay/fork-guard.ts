/**
 * Side-effect containment for a forked tail
 *
 * A fork re-runs real nodes. Left alone, the tail would call tools, reach
 * remote agents, and write facts into the production memory store — and a
 * counterfactual that writes lessons poisons exactly the pool it exists to
 * measure. The guard fails closed: unchanged work replays from the recording,
 * anything else stops.
 *
 * Node-level containment, not LLM-level. Agent nodes are the point of a fork
 * and always execute for real; the guard covers the node types that touch
 * something outside the run.
 *
 * @module replay/fork-guard
 */

import type { Graph, GraphNode, NodeType } from '../graph/graph.js';
import type { Action } from '../state/state.js';
import type { WorkflowEvent } from '../persistence/event.js';
import type { GraphRunnerMiddleware, MiddlewareContext, BeforeNodeResult } from '../execution/middleware/middleware.js';
import type { MemoryWriter } from '../memory/memory-writer.js';
import type { DefinedTool } from '../tools/define-tool.js';
import { SideEffectBlockedError } from './errors.js';

/**
 * How the tail treats nodes that touch the world.
 *
 * - `replay` — serve the recorded result when the base run executed this node
 *   at this iteration, and block otherwise. The default.
 * - `block` — never execute one, even with a recording available.
 * - `allow` — execute for real. Opt in per node id; `true` means all of them.
 */
export type SideEffectPolicy = 'replay' | 'block' | { allow: string[] | true };

/** Node types whose execution reaches outside the run. */
const EFFECTFUL: ReadonlySet<NodeType> = new Set<NodeType>(['tool', 'a2a', 'subgraph']);

/** One side effect the guard held back. */
export interface SuppressedEffect {
  nodeId: string;
  kind: 'tool' | 'a2a' | 'subgraph' | 'memory_write';
  reason: string;
}

/** Constructor input for {@link createForkGuard}. */
export interface ForkGuardDeps {
  /** The base run's events, the source of recorded results. */
  events: readonly WorkflowEvent[];
  /** How to treat effectful nodes. */
  policy: SideEffectPolicy;
  /** The overlaid graph the tail runs. */
  graph: Graph;
}

/** The middleware plus the record of what it held back. */
export interface ForkGuard {
  middleware: GraphRunnerMiddleware;
  /** Wrap a `MemoryWriter` so reflection writes are captured, not persisted. */
  wrapMemoryWriter(writer: MemoryWriter): MemoryWriter;
  /**
   * Stand-in implementations for custom tools the graph declares but the
   * caller did not supply.
   *
   * Preflight rejects a graph whose custom tool sources have no
   * `defineTool()` registration, and it runs before the guard gets a chance to
   * short-circuit anything. Without these, forking any graph containing a tool
   * node would mean re-supplying tools the fork exists to avoid calling. Each
   * stub throws if it is ever reached, which also backstops the middleware.
   */
  toolStubs(provided: ReadonlySet<string>): DefinedTool[];
  /** Everything suppressed so far. */
  readonly suppressed: SuppressedEffect[];
}

/** Recorded actions from the base run, keyed by node and iteration. */
function indexRecordedActions(events: readonly WorkflowEvent[]): Map<string, Action> {
  const byKey = new Map<string, Action>();
  let iteration = 0;

  for (const event of events) {
    if (event.event_type === 'internal_dispatched' && event.internal_type === '_increment_iteration') {
      iteration++;
      continue;
    }
    if (event.event_type !== 'action_dispatched' || !event.action) continue;
    const nodeId = event.node_id ?? event.action.metadata.node_id;
    byKey.set(`${nodeId}:${iteration}`, event.action);
  }

  return byKey;
}

/** Does the policy let this node run for real? */
function allows(policy: SideEffectPolicy, nodeId: string): boolean {
  if (typeof policy !== 'object') return false;
  return policy.allow === true || policy.allow.includes(nodeId);
}

/**
 * Build the guard for one forked run.
 *
 * Recorded results are matched on `(node, iteration)`. Once a tail diverges its
 * iterations stop lining up with the base run's, so the match fails and the
 * node is blocked. That is the conservative direction: a fork that stops is
 * recoverable, a fork that re-sends is not.
 */
export function createForkGuard(deps: ForkGuardDeps): ForkGuard {
  const recorded = indexRecordedActions(deps.events);
  const suppressed: SuppressedEffect[] = [];

  const nodeType = (node: GraphNode): 'tool' | 'a2a' | 'subgraph' =>
    node.type as 'tool' | 'a2a' | 'subgraph';

  const middleware: GraphRunnerMiddleware = {
    async beforeNodeExecute(ctx: MiddlewareContext): Promise<BeforeNodeResult | void> {
      const { node, state } = ctx;
      if (!EFFECTFUL.has(node.type)) return;
      if (allows(deps.policy, node.id)) return;

      if (deps.policy === 'block') {
        throw new SideEffectBlockedError(node.id, node.type, `policy.sideEffects is 'block'`);
      }

      // 'replay', and also an `allow` list that does not name this node: the
      // recording is the only safe way through.
      const action = recorded.get(`${node.id}:${state.iteration_count}`);
      if (action) {
        suppressed.push({
          nodeId: node.id,
          kind: nodeType(node),
          reason: 'served from the recording, inputs unchanged',
        });
        return { shortCircuit: action };
      }
      throw new SideEffectBlockedError(
        node.id,
        node.type,
        `the base run has no recorded result for iteration ${state.iteration_count}, ` +
        `so the tail has diverged and there is nothing safe to replay`,
      );
    },
  };

  // The wrapped writer is deliberately never called: capturing means the
  // facts are recorded here and reach no store at all.
  const wrapMemoryWriter = (_writer: MemoryWriter): MemoryWriter => async (facts, options) => {
    suppressed.push({
      nodeId: options?.idempotencyKey ?? 'reflection',
      kind: 'memory_write',
      reason: `${facts.length} fact(s) captured, not persisted`,
    });
    // Synthetic ids keep the reflection node's envelope well-formed while
    // nothing reaches the store. A fork that wrote lessons would contaminate
    // the pool that lesson attribution measures.
    return { fact_ids: facts.map((_, i) => `fork-suppressed-${i}`) };
  };

  const toolStubs = (provided: ReadonlySet<string>): DefinedTool[] => {
    const stubs: DefinedTool[] = [];
    const seen = new Set(provided);

    for (const node of deps.graph.nodes) {
      if (allows(deps.policy, node.id)) continue;
      for (const source of node.tools ?? []) {
        if (source.type !== 'custom' || seen.has(source.name)) continue;
        seen.add(source.name);
        stubs.push({
          name: source.name,
          description: `Fork stub for "${source.name}" — never executed.`,
          taints: false,
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            throw new SideEffectBlockedError(
              node.id,
              node.type,
              `custom tool "${source.name}" has no implementation in this fork, and the guard ` +
              `did not short-circuit the node`,
            );
          },
        });
      }
    }

    return stubs;
  };

  return { middleware, wrapMemoryWriter, toolStubs, suppressed };
}
