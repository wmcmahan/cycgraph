/**
 * Combination of co-proposed winners
 *
 * One-knob-at-a-time stays the search, for reasons that do not weaken with
 * scale: a factorial sweep over three knobs runs an order of magnitude more
 * forks to produce a winner that cannot say which knob earned it, and nothing
 * in telemetry observes a *combination* being wrong before the singles are
 * proposed. But a pass that emits two proposals is implicitly proposing a
 * third thing — both together, which is what a reader will apply — and that
 * composition was never measured. Knobs interact: a leaner prompt can let a
 * loop converge in fewer iterations, and a colder temperature can make a
 * tighter prompt brittle. Synergy and interference are both real, and neither
 * shows up in the singles.
 *
 * So when a pass produces two or more proposals from the same prefixes, the
 * bundle runs as its own two-arm sweep — an unchanged control and all winners
 * together — and the verdict says whether to apply them together, apply the
 * best alone, or that combining breaks what each preserved. The founding
 * constraint, extended one step: it must not co-propose a combination it has
 * not measured.
 *
 * @module sweep/combine
 */

import { detectConflicts } from '@cycgraph/orchestrator';
import type { Change } from '@cycgraph/orchestrator';
import type {
  KnobSweep,
  SweepProposal,
  SweepVerdict,
  VariantOutcome,
} from './types.js';

/**
 * Interference tolerance, as a fraction of execution time.
 *
 * The bundle and the singles were measured on different draws of the same
 * tails, so small disagreement is sampling. The bundle has to fall this far
 * short of the best single before the verdict calls it interference.
 */
const INTERFERENCE_MARGIN = 0.1;

/** A measured winner and the sweep it came from. */
interface Constituent {
  proposal: SweepProposal;
  sweep: KnobSweep;
}

/** The two-arm sweep a set of co-proposed winners forms. */
export interface CombinationPlan {
  /** The winners being composed, in sweep order. */
  constituents: Array<{ knob: string; nodeId: string; computeDelta: number }>;
  /** Every winner's changes, concatenated. */
  changes: Change[];
  /** Draws per arm: the largest any constituent used, so rates stay honest. */
  samples: number;
}

/** What measuring the composition concluded. */
export interface CombinationVerdict {
  decision: 'combine' | 'interference' | 'broken';
  /** One sentence a reader can act on. */
  reason: string;
  /** Bundle execution time removed, relative to the control arm. */
  computeDelta: number;
  /** The best single's claimed saving, for the comparison the verdict made. */
  bestSingleDelta: number;
  outcomes: VariantOutcome[];
}

/**
 * The bundle a pass's proposals form, when they form one.
 *
 * Only winners whose sweeps forked the same clean prefixes compose: a
 * correctness winner was measured where the workflow fails, and layering it
 * onto a clean prefix measures nothing about it. Changes that claim the same
 * thing cannot compose at all, and `detectConflicts` — the same gate a
 * hand-written multi-change fork passes through — decides that, not this
 * module.
 */
export function planCombination(
  sweeps: readonly KnobSweep[],
  verdicts: readonly SweepVerdict[],
): CombinationPlan | { skipped: string } | undefined {
  const constituents: Constituent[] = [];
  verdicts.forEach((verdict, index) => {
    const sweep = sweeps[index];
    if (verdict.kind !== 'proposal' || !sweep) return;
    if (sweep.prefixes === 'failing' || sweep.objective === 'correctness') return;
    constituents.push({ proposal: verdict.proposal, sweep });
  });

  if (constituents.length < 2) return undefined;

  const changes = constituents.flatMap(entry => entry.proposal.change);
  const conflicts = detectConflicts(changes);
  if (conflicts.length > 0) {
    return { skipped: `the winners claim the same thing and cannot compose: ${conflicts.join('; ')}` };
  }

  return {
    constituents: constituents.map(entry => ({
      knob: entry.proposal.knob,
      nodeId: entry.proposal.nodeId,
      computeDelta: entry.proposal.computeDelta,
    })),
    changes,
    samples: Math.max(...constituents.map(entry => entry.sweep.samples ?? 1)),
  };
}

/** Samples an arm passed: held every assertion and actually ran. */
function passCount(outcomes: readonly VariantOutcome[]): number {
  return outcomes.filter(o => o.assertionsHeld && !o.error).length;
}

/** Mean of a non-empty list. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Decide what the composed measurement supports.
 *
 * Three outcomes and each names its action. The bundle breaking any
 * assertion in any sample means the winners are apply-one-or-the-other,
 * whatever each saved. The bundle holding but falling well short of the best
 * single means the knobs interfere, and the best single alone is the
 * proposal. The bundle holding and matching or beating the best single means
 * apply together — with synergy visible as beating it.
 */
export function decideCombination(
  plan: CombinationPlan,
  control: readonly VariantOutcome[],
  bundle: readonly VariantOutcome[],
): CombinationVerdict {
  const outcomes = [...control, ...bundle];
  const best = [...plan.constituents].sort((a, b) => b.computeDelta - a.computeDelta)[0]!;

  if (control.length === 0 || bundle.length === 0) {
    return {
      decision: 'broken',
      reason: 'the combination was not measured on both arms, so nothing supports applying it together',
      computeDelta: 0,
      bestSingleDelta: best.computeDelta,
      outcomes,
    };
  }

  const controlMs = mean(control.map(o => o.computeMs));
  const bundleMs = mean(bundle.map(o => o.computeMs));
  const computeDelta = controlMs === 0 ? 0 : (controlMs - bundleMs) / controlMs;

  if (passCount(bundle) < bundle.length) {
    const failed = [...new Set(bundle.flatMap(o => o.error ? ['(errored)'] : o.failed))];
    return {
      decision: 'broken',
      reason: `combining breaks what each winner preserved (${failed.join(', ')}) — apply one, not both`,
      computeDelta,
      bestSingleDelta: best.computeDelta,
      outcomes,
    };
  }

  if (computeDelta < best.computeDelta - INTERFERENCE_MARGIN) {
    return {
      decision: 'interference',
      reason: `the knobs interfere: together they remove ${Math.round(computeDelta * 100)}% against ${Math.round(best.computeDelta * 100)}% for ${best.nodeId}.${best.knob} alone — apply that alone`,
      computeDelta,
      bestSingleDelta: best.computeDelta,
      outcomes,
    };
  }

  return {
    decision: 'combine',
    reason: `together they hold every assertion and remove ${Math.round(computeDelta * 100)}% of execution time — apply together`,
    computeDelta,
    bestSingleDelta: best.computeDelta,
    outcomes,
  };
}
