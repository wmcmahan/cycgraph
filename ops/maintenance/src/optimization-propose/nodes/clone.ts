/**
 * clone — the run's entry node: set up the disposable workspace.
 *
 * @module maintenance/optimization-propose/nodes/clone
 */

import { node } from '@cycgraph/orchestrator';
import type { OptProposeTools } from '../tools/index.js';

/** The clone_repo tool node. */
export function cloneNode(tools: OptProposeTools) {
  return node({
    id: 'clone',
    type: 'tool',
    toolId: 'clone_repo',
    tools: [tools.clone],
    reads: []
  });
}
