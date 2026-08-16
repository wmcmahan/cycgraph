/**
 * a2a() — delegate a step to a remote agent
 *
 * The remote sibling of {@link subgraph}. Both place a unit of work in the
 * topology and map memory across a boundary; this one crosses a network
 * instead of a process, and the node type is what discloses that.
 *
 * A server id, never a URL. Endpoints and credentials live in the trusted
 * A2A server registry, so a graph — including one an LLM wrote — cannot
 * name an arbitrary host or read what is used to reach one.
 *
 * @module authoring/a2a
 */

import { withMappedOutputs, type MappedOutputsFor } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/**
 * Authoring spec for {@link a2a}: placement, grants, and mappings.
 *
 * `budget` is deliberately absent. A per-node cap is measured against the
 * tokens and cost a node reports, and a remote agent reports none: its spend
 * happens on infrastructure this engine cannot meter. Accepting the field
 * would promise a cap that could never fire. `maxWaitMs` and the failure
 * policy are the bounds that do apply.
 */
export interface A2ASpec extends Omit<NodeCommon, 'budget'> {
  /**
   * Parent memory key(s) this node may write. The parent-side keys of
   * `outputs` are already implied grants; declare this only to add a key
   * the mapping does not name.
   */
  writes?: string | string[];
  /**
   * Which advertised skill this node intends to invoke. Recorded for
   * readers and tooling; not sent on the wire.
   */
  skill?: string;
  /** Parent key → remote message part. */
  inputs?: Record<string, string>;
  /** Remote artifact name → parent key. */
  outputs?: Record<string, string>;
  /**
   * How long to wait for the task to finish. Falls back to the registry
   * entry's `task_timeout_ms`.
   */
  maxWaitMs?: number;
}

/**
 * Author an `a2a` node: delegate `spec.id` to the registered remote agent
 * `serverId`.
 *
 * @param serverId - Id of an entry in the A2A server registry.
 * @param spec - Placement, grants, and the input/output mappings.
 */
export function a2a<const S extends A2ASpec>(serverId: string, spec: S): NodeValue & MappedOutputsFor<S> {
  const { skill, inputs, outputs, maxWaitMs, ...placement } = spec;

  return withMappedOutputs({
    ...placement,
    type: 'a2a' as const,
    a2aConfig: {
      serverId,
      ...(skill !== undefined ? { skillId: skill } : {}),
      ...(inputs !== undefined ? { inputMapping: inputs } : {}),
      ...(outputs !== undefined ? { outputMapping: outputs } : {}),
      ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue, spec.outputs) as NodeValue & MappedOutputsFor<S>;
}
