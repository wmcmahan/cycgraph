/**
 * synthesizer() — fold fan-out results into one value
 *
 * The agent is optional, which is why it sits in the spec rather than leading.
 * The two paths differ in what they write, so they differ in what they need
 * declared:
 *
 *   - No agent: results are merged deterministically into the implied
 *     `${id}_synthesis` key, and nothing need be declared.
 *   - With an agent: the agent authors the output under the keys `writes`
 *     names, exactly as on an agent node. Omitting `writes` leaves it able to
 *     write nothing.
 *
 * @module authoring/synthesizer
 */

import type { AgentValue } from './agent.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link synthesizer}. */
export interface SynthesizerSpec extends NodeCommon {
  /** Agent that writes the synthesis. Omit for a deterministic merge. */
  agent?: AgentValue | string;
  /**
   * Memory key(s) the agent may write. Required when `agent` is set, since an
   * agent-backed synthesizer authors its output rather than writing the
   * implied `${id}_synthesis` key.
   */
  writes?: string | string[];
}

/**
 * Author a `synthesizer` node.
 *
 * @param spec - Placement, the keys to merge, and an optional agent.
 */
export function synthesizer(spec: SynthesizerSpec): NodeValue {
  return { ...spec, type: 'synthesizer' as const, [NODE_BRAND]: true as const } as NodeValue;
}
