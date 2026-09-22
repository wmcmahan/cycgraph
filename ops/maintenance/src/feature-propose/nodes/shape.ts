/**
 * shape — validate the proposal's structure and evidence.
 *
 * @module maintenance/feature-propose/nodes/shape
 */

import { node } from '@cycgraph/orchestrator';
import type { FeatProposeTools } from '../tools/index.js';

/** The check_shape tool node. */
export function shapeNode(tools: FeatProposeTools) {
  return node({
    id: 'shape',
    type: 'tool',
    toolId: 'check_shape',
    tools: [tools.shape],
    reads: ['proposal', 'shape_result']
  });
}
