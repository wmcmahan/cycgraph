/**
 * gate — the pass/loop decision.
 *
 * An expression verifier over the checks result: the revision passes only
 * when it changed the tree, the checks are clean, and nothing mutated it
 * further. A failed gate loops back to the reviser.
 *
 * @module maintenance/pr-revise/nodes/gate
 */

import { verifier } from '@cycgraph/orchestrator';
import type { checksNode } from './checks.js';

/** The expression-verifier gate reading checks' result. */
export function gateNode(checks: ReturnType<typeof checksNode>) {
  return verifier.expression(
    `memory.${checks.result}.clean and memory.${checks.result}.has_changes`,
    {
      id: 'gate',
      description: 'The revision changed the tree, the checks pass, and nothing mutated it further',
      reads: [checks.result],
    },
  );
}
