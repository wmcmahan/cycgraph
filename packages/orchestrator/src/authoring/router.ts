/**
 * router() — a branch point with no work of its own
 *
 * Takes no config. Routing lives on the outgoing edges' conditions, so the
 * node exists to give those edges somewhere to leave from.
 *
 * @module authoring/router
 */

import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link router}. */
export interface RouterSpec extends NodeCommon {
  /** Memory key(s) this node may write. */
  writes?: string | string[];
}

/**
 * Author a `router` node.
 *
 * @param spec - Placement and the keys its edge conditions read.
 */
export function router(spec: RouterSpec): NodeValue {
  return { ...spec, type: 'router' as const, [NODE_BRAND]: true as const } as NodeValue;
}
