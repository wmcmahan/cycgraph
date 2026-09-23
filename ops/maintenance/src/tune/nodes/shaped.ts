/**
 * shaped — the trial/retry decision.
 *
 * An expression verifier: the proposal names a real file and quotes text
 * that exists exactly once. A failure loops back to the analyst until the
 * attempt budget is spent.
 *
 * @module maintenance/tune/nodes/shaped
 */

import { verifier } from '@cycgraph/orchestrator';
import type { shapeNode } from './shape.js';

/** The expression-verifier gate over the shape result. */
export function shapedNode(shape: ReturnType<typeof shapeNode>) {
  return verifier.expression(
    `memory.${shape.result}.valid`,
    { id: 'shaped', reads: [shape.result], description: 'The proposal names a real file and quotes text that exists exactly once' },
  );
}
