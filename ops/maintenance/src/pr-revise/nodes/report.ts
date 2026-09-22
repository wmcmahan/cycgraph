/**
 * report — the run's terminal node.
 *
 * A router with no outgoing edges: every path ends here, whether the run
 * delivered a revision or found no feedback to address.
 *
 * @module maintenance/pr-revise/nodes/report
 */

import { node } from '@cycgraph/orchestrator';

/** The terminal router node. */
export function reportNode() {
  return node({
    id: 'report',
    type: 'router',
  });
}
