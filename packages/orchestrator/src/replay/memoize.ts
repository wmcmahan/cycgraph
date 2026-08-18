/**
 * Memoized re-execution
 *
 * A fork re-runs its tail because the change might affect it. Might is doing
 * the work there: in a graph of any width, a change to one branch leaves other
 * nodes reading exactly what they read before, and calling the model again
 * just resamples an answered question.
 *
 * This indexes the base run's outputs by input fingerprint and serves them to
 * tail nodes whose inputs are unchanged. What it saves grows with the distance
 * between the fork point and the end of the graph.
 *
 * **Off by default.** Serving a recorded output means that node did not run,
 * and "the tail runs live" is the promise a fork makes. Enabling it is worth
 * it in two cases. It removes sampling noise from a comparison, since a node
 * that was never going to be affected by the change now cannot drift and
 * muddy the diff. And it makes sweeps affordable, because the unaffected
 * suffix is paid for once rather than once per variant.
 *
 * @module replay/memoize
 */

import type { Graph } from '../graph/graph.js';
import type { Action, WorkflowState } from '../state/state.js';
import type { AgentRegistry } from '../persistence/interfaces.js';
import type { WorkflowEvent } from '../persistence/event.js';
import type { GraphRunnerMiddleware, MiddlewareContext, BeforeNodeResult } from '../execution/middleware/middleware.js';
import { replayEvents } from './replay-events.js';
import { computeFingerprint } from './fingerprint.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('replay.memoize');

/** A base-run execution that can be replayed instead of re-run. */
export interface MemoEntry {
  nodeId: string;
  fingerprint: string;
  action: Action;
}

/** One node served from the recording. */
export interface MemoHit {
  nodeId: string;
  fingerprint: string;
}

/** The middleware plus what it served. */
export interface Memoizer {
  middleware: GraphRunnerMiddleware;
  /** Entries indexed from the base run. */
  readonly size: number;
  /** Nodes served from the recording. */
  readonly hits: MemoHit[];
}

/**
 * Index the base run's executions by the inputs that produced them.
 *
 * Walks the log the way the run did, so the state at each `node_started` is
 * the state that node actually read. The action that follows it in the same
 * group is what those inputs produced.
 */
export async function indexBaseRun(
  graph: Graph,
  events: readonly WorkflowEvent[],
  seedState: WorkflowState,
  registry: AgentRegistry,
  options?: {
    /** Index only executions at or after this sequence id. */
    fromSequenceId?: number;
  },
): Promise<Map<string, MemoEntry[]>> {
  const index = new Map<string, MemoEntry[]>();
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]));

  const from = options?.fromSequenceId ?? 0;
  for (const [i, event] of events.entries()) {
    if (event.event_type !== 'node_started' || !event.node_id) continue;
    if (event.sequence_id < from) continue;
    const node = nodesById.get(event.node_id);
    if (!node) continue;

    // The action this node produced: the next action_dispatched before any
    // other node starts. A node that produced none (it failed, or the run
    // ended) has nothing to memoize.
    const action = findGroupAction(events, i);
    if (!action) continue;

    const before = replayEvents(events, seedState, {
      stopBefore: ({ event: e }) => e.sequence_id >= event.sequence_id,
    }).state;

    const fingerprint = await computeFingerprint({ node, graph, state: before, registry });
    if (!fingerprint) continue;

    // A fingerprint can recur: a fix-loop reruns a node on identical inputs
    // expecting a different draft, and a supervisor can send a worker the
    // same slice twice. Executions queue in recorded order and each hit
    // consumes one, so a repeated node replays exactly the sequence of
    // outputs the base run produced — the loop progresses as recorded rather
    // than freezing at its first attempt, and a null fork reproduces a run
    // whose node ran twice on the same inputs instead of resampling it live.
    const queue = index.get(fingerprint) ?? [];
    queue.push({ nodeId: node.id, fingerprint, action });
    index.set(fingerprint, queue);
  }

  return index;
}

/** The action a node's own event group produced, if it produced one. */
function findGroupAction(events: readonly WorkflowEvent[], startIndex: number): Action | undefined {
  for (let i = startIndex + 1; i < events.length; i++) {
    const event = events[i];
    if (event.event_type === 'node_started') return undefined;
    if (event.event_type === 'action_dispatched' && event.action) return event.action;
  }
  return undefined;
}

/** Build the middleware that serves indexed outputs to unchanged nodes. */
export function createMemoizer(deps: {
  index: Map<string, MemoEntry[]>;
  graph: Graph;
  registry: AgentRegistry;
}): Memoizer {
  const hits: MemoHit[] = [];
  const consumed = new Map<string, number>();

  const middleware: GraphRunnerMiddleware = {
    async beforeNodeExecute(ctx: MiddlewareContext): Promise<BeforeNodeResult | void> {
      const fingerprint = await computeFingerprint({
        node: ctx.node,
        graph: deps.graph,
        state: ctx.state as WorkflowState,
        registry: deps.registry,
      });
      if (!fingerprint) return;

      const queue = deps.index.get(fingerprint);
      const position = consumed.get(fingerprint) ?? 0;
      const entry = queue?.[position];
      // A tail that revisits a fingerprint more times than the base run
      // recorded has exhausted the queue, and the extra visits run live.
      // The fingerprint covers the node id, so a match from a different node
      // is not possible; the check documents the invariant rather than
      // defending against it.
      if (!entry || entry.nodeId !== ctx.node.id) return;
      consumed.set(fingerprint, position + 1);

      hits.push({ nodeId: ctx.node.id, fingerprint });
      logger.debug('memo_hit', { node_id: ctx.node.id, fingerprint });
      return { shortCircuit: entry.action };
    },
  };

  return {
    middleware,
    get size() {
      let total = 0;
      for (const queue of deps.index.values()) total += queue.length;
      return total;
    },
    hits,
  };
}
