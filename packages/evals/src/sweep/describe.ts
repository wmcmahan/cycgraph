/**
 * Rendering sweep results
 *
 * One line each, phrased as what was measured rather than what to do. A
 * proposal that does not show its working is indistinguishable from a guess,
 * which is the thing this whole design exists to avoid.
 *
 * @module sweep/describe
 */

import type { SweepProposal, SweepVerdict } from './types.js';

/** A percentage with a sign, since the direction is the point. */
function percent(fraction: number): string {
  const rounded = Math.round(fraction * 100);
  return `${rounded >= 0 ? '−' : '+'}${Math.abs(rounded)}%`;
}

/** What a proposal changes, and what that bought. */
export function describeProposal(proposal: SweepProposal): string {
  const cost = `${percent(proposal.computeDelta)} execution time, ${percent(proposal.tokenDelta)} tokens`;
  const across = `across ${proposal.measuredOn.length} base run(s) on ${proposal.model}`;

  if (proposal.objective === 'reliability' && proposal.reliability) {
    const r = proposal.reliability;
    return `${proposal.nodeId}.${proposal.knob}: ${proposal.from} → ${proposal.to} holds assertions in `
      + `${r.winnerPassed}/${r.winnerOf} sample(s) against the control's ${r.controlPassed}/${r.controlOf} `
      + `(p=${r.pValue.toFixed(3)}), at ${cost}, ${across}`;
  }
  return proposal.objective === 'correctness'
    ? `${proposal.nodeId}.${proposal.knob}: ${proposal.from} → ${proposal.to} makes every assertion hold, at ${cost}, ${across}`
    : `${proposal.nodeId}.${proposal.knob}: ${proposal.from} → ${proposal.to} holds every assertion at ${cost}, ${across}`;
}

/** What a sweep concluded, proposal or not. */
export function describeVerdict(verdict: SweepVerdict): string {
  return verdict.kind === 'proposal'
    ? describeProposal(verdict.proposal)
    : `${verdict.rejection.nodeId}.${verdict.rejection.knob}: ${verdict.rejection.reason}`;
}
