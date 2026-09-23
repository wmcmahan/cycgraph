/**
 * gate — the deliver/retry decision.
 *
 * An expression verifier: the implementation passes only when something was
 * built, every runnable acceptance criterion passed, and the checks pass. A
 * failed gate loops back to the implementer.
 *
 * @module maintenance/implement-ticket/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { acceptNode } from './accept.js';
import type { checksNode } from './checks.js';

/** The expression-verifier gate reading the accept and checks results. */
export function gateNode(accept: ReturnType<typeof acceptNode>, checks: ReturnType<typeof checksNode>) {
  return verifier.expression(
    `memory.${accept.result}.passed and memory.${checks.result}.clean`,
    {
      id: 'gate',
      reads: [accept.result, checks.result],
      description: 'Something was built, every runnable acceptance criterion passed, and the checks pass',
    },
  );
}
