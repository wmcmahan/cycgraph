/**
 * gate — the ticket/retry decision.
 *
 * An expression verifier: the proposal passes only when it is reviewable —
 * all sections present, evidence naming real files. A failed gate loops
 * back to the drafter until the attempt budget is spent.
 *
 * @module maintenance/feature-propose/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { shapeNode } from './shape.js';

/** The expression-verifier gate reading the shape result. */
export function gateNode(shape: ReturnType<typeof shapeNode>) {
  return verifier.expression(
    `memory.${shape.result}.valid`,
    {
      id: 'gate',
      reads: [shape.result],
      description: 'The proposal is reviewable: all sections present, evidence names real files',
    },
  );
}
