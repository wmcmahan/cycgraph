/**
 * supervisor() — an LLM node that routes work to other nodes
 *
 * The routing agent comes first because it is what the node is: a brain that
 * picks the next step. `manages` names the nodes it may delegate to, by value
 * or by id.
 *
 * A supervisor derives its reads from its managed nodes' write keys when
 * `reads` is omitted, and its routing and completion permissions from the node
 * type. Declaring either is usually unnecessary.
 *
 * @module authoring/supervisor
 */

import type { MemoryQuery } from '../graph/graph.js';
import type { AgentValue } from './agent.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link supervisor}. */
export interface SupervisorSpec extends NodeCommon {
  /** Nodes this supervisor may delegate to, by value or id. */
  manages: (NodeValue | string)[];
  /** Routing turns before the run is forced to complete. */
  maxIterations?: number;
  /** Memory key(s) the supervisor's agent may write. */
  writes?: string | string[];
  /** Retrieval directive applied before the routing prompt is built. */
  memoryQuery?: MemoryQuery;
}

/**
 * Author a `supervisor` node.
 *
 * @param brain - The agent that makes routing decisions.
 * @param spec - Placement, the managed set, and routing limits.
 */
export function supervisor(brain: AgentValue | string, spec: SupervisorSpec): NodeValue {
  const { manages, maxIterations, ...placement } = spec;

  return {
    ...placement,
    type: 'supervisor' as const,
    agent: brain,
    supervisorConfig: {
      managedNodes: manages,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue;
}
