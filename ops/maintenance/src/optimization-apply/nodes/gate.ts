/**
 * gate — the commit/give-up decision.
 *
 * An expression verifier: the change commits only when the measured
 * improvement still holds, nothing regressed, and the checks pass. A
 * failed gate gives up — a diff that stopped measuring needs a fresh
 * proposal, not another identical application.
 *
 * @module maintenance/optimization-apply/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { verdictNode } from './verdict.js';
import type { checksNode } from './checks.js';

/** The expression-verifier gate reading the verdict and checks results. */
export function gateNode(verdict: ReturnType<typeof verdictNode>, checks: ReturnType<typeof checksNode>) {
  return verifier.expression(
    `memory.${verdict.result}.improved_count >= 1 and memory.${verdict.result}.regressed_count == 0`
      + ` and memory.${checks.result}.clean`,
    {
      id: 'gate',
      reads: [verdict.result, checks.result],
      description: 'The measured improvement still holds, nothing regressed, and the checks pass',
    },
  );
}
