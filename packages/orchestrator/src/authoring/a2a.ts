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

import { NODE_BRAND, type NodeValue } from './node.js';

/** Authoring spec for {@link a2a}: placement, grants, and mappings. */
export interface A2ASpec {
  /** Node id in the topology. */
  id: string;
  /** Parent memory keys this node may read (the input slice). */
  reads?: string[];
  /**
   * Parent memory key(s) this node may write.
   *
   * Usually unnecessary: the parent-side keys of `outputs` are implied
   * grants, exactly as they are for `subgraph()`. Declare it only to add a
   * key the mapping does not name.
   */
  writes?: string | string[];
  /**
   * Which advertised skill this node intends to invoke.
   *
   * Records intent for readers and tooling. Nothing in the A2A client
   * surface takes a skill id, so it is not sent on the wire.
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
export function a2a(serverId: string, spec: A2ASpec): NodeValue {
  const { skill, inputs, outputs, maxWaitMs, ...placement } = spec;

  return {
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
  } as NodeValue;
}
