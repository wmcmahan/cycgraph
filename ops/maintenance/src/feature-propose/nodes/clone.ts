/**
 * clone — the run's entry node: clone and map the workspace.
 *
 * @module maintenance/feature-propose/nodes/clone
 */

import { node } from '@cycgraph/orchestrator';
import type { FeatProposeTools } from '../tools/index.js';

/** The clone_repo tool node. */
export function cloneNode(tools: FeatProposeTools) {
  return node({
    id: 'clone',
    type: 'tool',
    toolId: 'clone_repo',
    tools: [tools.clone],
    reads: []
  });
}
