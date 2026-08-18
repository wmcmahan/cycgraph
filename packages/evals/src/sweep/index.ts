/**
 * Deterministic knob sweeps
 *
 * A finding names a node and a knob, the knob has a finite set of values, and
 * each is measured against the same recorded prefix. No model is involved in
 * proposing anything, so there is nothing to hallucinate: every proposal is a
 * measurement result.
 *
 * @module sweep
 */

export type {
  KnobSweep,
  KnobValue,
  SweepObjective,
  VariantOutcome,
  BaselineOutcome,
  SweepProposal,
  SweepRejection,
  SweepVerdict,
} from './types.js';

export { enumerateSweeps, enumerateFromFinding, enumerateFromProfile } from './knobs.js';
export type { SweepInputs } from './knobs.js';
export { decideSweep } from './decide.js';
export { planCombination, decideCombination } from './combine.js';
export type { CombinationPlan, CombinationVerdict } from './combine.js';
export {
  enumeratePromptBrief,
  enumerateLeanPromptBrief,
  renderPromptBrief,
  sanitizePromptCandidates,
  buildPromptSweep,
} from './prompts.js';
export type { PromptBrief } from './prompts.js';
export { describeProposal, describeVerdict } from './describe.js';
