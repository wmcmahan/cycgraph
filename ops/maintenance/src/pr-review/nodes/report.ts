/**
 * report — the run's terminal node.
 *
 * A router with no outgoing edges: every path ends here, whether the run
 * posted a review or found no PR to review.
 *
 * @module maintenance/pr-review/nodes/report
 */

import { node } from '@cycgraph/orchestrator';

/** The terminal router node. */
export function reportNode() {
  return node({ id: 'report', type: 'router' });
}
