/**
 * report — the run's terminal node.
 *
 * A router with no outgoing edges: every path ends here — a delivered PR,
 * a clean no-work exit, or a flagged give-up.
 *
 * @module maintenance/issue-fix/nodes/report
 */

import { node } from '@cycgraph/orchestrator';

/** The terminal router node. */
export function reportNode() {
  return node({ id: 'report', type: 'router' });
}
