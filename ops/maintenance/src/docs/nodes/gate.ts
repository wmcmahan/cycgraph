/**
 * gate — the commit/retry decision.
 *
 * An expression verifier: the fix passes only when the claim was corrected
 * rather than deleted, nothing new broke, and the checks still pass.
 *
 * @module maintenance/docs/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { judgeNode } from './judge.js';
import type { checksNode } from './checks.js';

/** The expression-verifier gate reading the judge and checks results. */
export function gateNode(judge: ReturnType<typeof judgeNode>, checks: ReturnType<typeof checksNode>) {
  return verifier.expression(
    `memory.${judge.result}.resolved and not memory.${judge.result}.weakened`
      + ` and memory.${judge.result}.introduced_count == 0 and memory.${checks.result}.clean`,
    {
      id: 'gate',
      reads: [judge.result, checks.result],
      description: 'The claim was corrected rather than deleted, nothing new broke, and the checks still pass',
    },
  );
}
