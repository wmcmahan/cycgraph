/**
 * trial — measure the edit: control vs variant, as dry subprocesses.
 *
 * @module maintenance/tune/nodes/trial
 */

import { node } from '@cycgraph/orchestrator';
import type { TuneTools } from '../tools/index.js';
import type { shapeNode } from './shape.js';

/** The run_trials tool node, reading the shaped edit. */
export function trialNode(tools: TuneTools, shape: ReturnType<typeof shapeNode>) {
  return node({ id: 'trial', type: 'tool', toolId: 'run_trials', tools: [tools.trial], reads: [shape.result] });
}
