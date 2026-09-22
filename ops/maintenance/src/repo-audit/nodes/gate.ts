/**
 * gate — the file/report decision.
 *
 * An expression verifier over the sift result: the fan-out produced auditor
 * reports and the issue ledger was readable. A clean audit and a failed
 * fan-out both end at report; the gate boolean and the sift accounting say
 * which happened.
 *
 * @module maintenance/repo-audit/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { siftNode } from './sift.js';

/** The expression-verifier gate reading the sift result. */
export function gateNode(sift: ReturnType<typeof siftNode>) {
  return verifier.expression(
    `memory.${sift.result}.ok`,
    {
      id: 'gate',
      reads: [sift.result],
      description: 'The fan-out produced auditor reports and the issue ledger was readable',
    },
  );
}
