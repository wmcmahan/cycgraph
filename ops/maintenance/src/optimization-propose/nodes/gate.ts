/**
 * gate — the ticket/retry decision.
 *
 * An expression verifier: a proposal passes only when at least one
 * benchmark measurably improved, none regressed, the change stayed in
 * scope, and the checks pass. A failed gate loops back to the optimizer.
 *
 * @module maintenance/optimization-propose/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { verdictNode } from './verdict.js';
import type { checksNode } from './checks.js';

/** The expression-verifier gate reading the verdict and checks results. */
export function gateNode(verdict: ReturnType<typeof verdictNode>, checks: ReturnType<typeof checksNode>) {
  return verifier.expression(
    `memory.${verdict.result}.improved_count >= 1 and memory.${verdict.result}.regressed_count == 0`
      + ` and memory.${verdict.result}.out_of_scope_count == 0 and memory.${checks.result}.clean`,
    {
      id: 'gate',
      reads: [verdict.result, checks.result],
      description: 'At least one benchmark measurably improved, none regressed, and the change stayed in scope',
    },
  );
}
