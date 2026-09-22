/**
 * shape — validate the proposed edit against the maintenance source.
 *
 * @module maintenance/tune/nodes/shape
 */

import { node } from '@cycgraph/orchestrator';
import type { TuneTools } from '../tools/index.js';

/** The check_proposal tool node. */
export function shapeNode(tools: TuneTools) {
  return node({ id: 'shape', type: 'tool', toolId: 'check_proposal', tools: [tools.shape], reads: ['proposal', 'shape_result'] });
}
