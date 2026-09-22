/**
 * report — the run's terminal node.
 *
 * @module maintenance/code-scan/nodes/report
 */

import { node } from '@cycgraph/orchestrator';

/** The terminal router node. */
export function reportNode() {
  return node({ id: 'report', type: 'router' });
}
