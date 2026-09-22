/**
 * report — the run's terminal node.
 *
 * @module maintenance/implement-ticket/nodes/report
 */

import { node } from '@cycgraph/orchestrator';

/** The terminal router node. */
export function reportNode() {
  return node({ id: 'report', type: 'router' });
}
