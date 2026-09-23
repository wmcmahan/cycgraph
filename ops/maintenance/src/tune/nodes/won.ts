/**
 * won — the file/report decision.
 *
 * An expression verifier: the variant arm measurably beat control. A
 * losing variant ends cleanly — the measurement was the work.
 *
 * @module maintenance/tune/nodes/won
 */

import { verifier } from '@cycgraph/orchestrator';
import type { trialNode } from './trial.js';

/** The expression-verifier gate over the trial result. */
export function wonNode(trial: ReturnType<typeof trialNode>) {
  return verifier.expression(
    `memory.${trial.result}.wins`,
    { id: 'won', reads: [trial.result], description: 'The variant arm measurably beat control' },
  );
}
