/**
 * sense — the run's entry node: read the corpus for the target's signal.
 *
 * @module maintenance/tune/nodes/sense
 */

import { node } from '@cycgraph/orchestrator';
import type { TuneTools } from '../tools/index.js';

/** The sense_target tool node. */
export function senseNode(tools: TuneTools) {
  return node({ id: 'sense', type: 'tool', toolId: 'sense_target', tools: [tools.sense], reads: [] });
}
