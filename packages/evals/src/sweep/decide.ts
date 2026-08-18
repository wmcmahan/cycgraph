/**
 * Sweep decision
 *
 * Turns measured outcomes into a proposal, or into a reason there is none.
 * Pure: it runs nothing and reads nothing, so the rule that accepts a change
 * is testable without spending a single model call.
 *
 * Three rules, and they are what keep this from being an optimiser that
 * degrades the workflow it is optimising:
 *
 * 1. **Assertions are a constraint, not a term.** A candidate that breaks one
 *    is rejected whatever it saved. Correctness is never traded against cost.
 * 2. **A directed result is required.** A candidate that changes nothing
 *    measurable is not an improvement, and the absence of harm is not evidence
 *    of benefit.
 * 3. **It must hold everywhere it was measured.** One base run is one
 *    trajectory. A candidate that wins on one prefix and loses on another has
 *    found a property of that prefix.
 *
 * @module sweep/decide
 */

import { fisherExactOneSided } from './stats.js';
import type {
  BaselineOutcome,
  KnobSweep,
  KnobValue,
  SweepProposal,
  SweepVerdict,
  VariantOutcome,
} from './types.js';

/**
 * Fraction of the baseline a cost candidate must remove.
 *
 * Tails are not deterministic, so a couple of percent is the same run twice.
 * The threshold is what separates a saving from a redraw.
 */
const MIN_SAVING = 0.1;

/**
 * One-sided significance level for a reliability comparison.
 *
 * Applied to a single pre-registered comparison per sweep — winner against
 * control — so there is no multiplicity to correct for.
 */
const ALPHA = 0.05;

/**
 * The value a variant name encodes, e.g. `max_iterations=2` or `model=llama3`.
 *
 * Numeric when it parses as one, so a budget keeps its order and a model name
 * stays the string it is.
 */
function valueOf(name: string): KnobValue | undefined {
  const raw = name.slice(name.indexOf('=') + 1);
  if (raw === '' || !name.includes('=')) return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

/** Mean of a non-empty list. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** A candidate's outcomes across every base run it was measured on. */
interface Candidate {
  name: string;
  value: KnobValue;
  outcomes: VariantOutcome[];
  computeMs: number;
  tokens: number;
}

/** Group outcomes by candidate, keeping only those measured everywhere. */
function candidates(
  sweep: KnobSweep,
  measured: readonly VariantOutcome[],
  expectedRuns: number,
): Candidate[] {
  const byName = new Map<string, VariantOutcome[]>();
  for (const outcome of measured) {
    const list = byName.get(outcome.name) ?? [];
    list.push(outcome);
    byName.set(outcome.name, list);
  }

  const grouped: Candidate[] = [];
  for (const name of Object.keys(sweep.variants)) {
    const outcomes = byName.get(name) ?? [];
    // A candidate that did not run everywhere cannot be said to hold
    // everywhere, so it is not eligible rather than judged on what it has.
    if (outcomes.length < expectedRuns) continue;

    const value = valueOf(name);
    if (value === undefined) continue;

    grouped.push({
      name,
      value,
      outcomes,
      computeMs: mean(outcomes.map(o => o.computeMs)),
      tokens: mean(outcomes.map(o => o.tokens)),
    });
  }
  return grouped;
}

/** A fraction removed relative to a baseline, guarding a zero baseline. */
function delta(baseline: number, candidate: number): number {
  if (baseline === 0) return 0;
  return (baseline - candidate) / baseline;
}

function propose(
  sweep: KnobSweep,
  winner: Candidate,
  baselines: readonly BaselineOutcome[],
  all: readonly VariantOutcome[],
  model: string,
  against?: { computeMs: number; tokens: number },
): SweepProposal {
  const base = against ?? {
    computeMs: mean(baselines.map(b => b.computeMs)),
    tokens: mean(baselines.map(b => b.tokens)),
  };
  return {
    sweepId: sweep.id,
    workflow: sweep.workflow,
    nodeId: sweep.nodeId,
    knob: sweep.knob,
    from: sweep.current,
    to: winner.value,
    objective: sweep.objective,
    model,
    change: sweep.variants[winner.name]!,
    computeDelta: delta(base.computeMs, winner.computeMs),
    tokenDelta: delta(base.tokens, winner.tokens),
    measuredOn: baselines.map(b => b.runId),
    outcomes: [...all],
  };
}

function reject(sweep: KnobSweep, reason: string, outcomes: readonly VariantOutcome[]): SweepVerdict {
  return {
    kind: 'rejected',
    rejection: {
      sweepId: sweep.id,
      workflow: sweep.workflow,
      nodeId: sweep.nodeId,
      knob: sweep.knob,
      reason,
      outcomes: [...outcomes],
    },
  };
}

/**
 * Decide what a sweep's measurements support.
 *
 * Rejection is the expected outcome and carries the reason, because "we tried
 * three values and none was better" is a result worth reading. A sweep that
 * silently produces nothing is indistinguishable from one that never ran.
 */
export function decideSweep(
  sweep: KnobSweep,
  baselines: readonly BaselineOutcome[],
  measured: readonly VariantOutcome[],
  model = 'unknown',
): SweepVerdict {
  if (baselines.length === 0) {
    return reject(
      sweep,
      sweep.objective === 'correctness'
        ? 'no failing run left an event log to fork, so the failure cannot be reproduced'
        : 'no base run was measured to compare against',
      measured,
    );
  }

  const expectedRuns = baselines.length * (sweep.samples ?? 1);
  const eligible = candidates(sweep, measured, expectedRuns);
  if (eligible.length === 0) {
    return reject(sweep, `no candidate completed all ${expectedRuns} run(s)`, measured);
  }

  if (sweep.objective === 'reliability') {
    return decideReliability(sweep, baselines, eligible, measured, model);
  }

  const held = eligible.filter(c => c.outcomes.every(o => o.assertionsHeld && !o.error));

  // An erroring candidate and a failing one both fail to hold, and saying so
  // in one sentence loses the distinction that matters: a candidate the engine
  // refused never got as far as being wrong about the workflow.
  const everyCandidateErrored = held.length === 0
    && eligible.every(c => c.outcomes.some(o => o.error));
  const firstError = eligible.flatMap(c => c.outcomes).find(o => o.error)?.error;

  if (sweep.objective === 'correctness') {
    // The baseline is already failing, so paying more is acceptable and the
    // only question is whether the assertions turn green. Cheapest first
    // among those that do, since there is no reason to buy more room than the
    // workflow needs.
    if (baselines.every(b => b.assertionsHeld)) {
      return reject(
        sweep,
        'every base run already holds its assertions, so a fix measured on these prefixes fixes nothing',
        measured,
      );
    }
    if (everyCandidateErrored) {
      return reject(sweep, `every candidate failed to run: ${firstError}`, measured);
    }
    const control = sweep.control ? eligible.find(c => c.name === sweep.control) : undefined;
    if (control && control.outcomes.every(o => o.assertionsHeld && !o.error)) {
      return reject(
        sweep,
        'the failure did not reproduce: the unchanged value already holds every assertion on these prefixes, so the budget is not what decides it',
        measured,
      );
    }

    const winners = held.filter(c => c.name !== sweep.control);
    if (winners.length === 0) {
      return reject(sweep, 'no candidate made every assertion hold', measured);
    }
    // Cheapest room that works. A numeric budget orders itself, so buy the
    // smallest that holds; anything else has no order of its own, so the
    // measurement decides and the cheapest to run wins.
    const ordered = winners.every(c => typeof c.value === 'number')
      ? [...winners].sort((a, b) => (a.value as number) - (b.value as number))
      : [...winners].sort((a, b) => a.computeMs - b.computeMs);
    const winner = ordered[0]!;
    return { kind: 'proposal', proposal: propose(sweep, winner, baselines, measured, model) };
  }

  if (baselines.some(b => !b.assertionsHeld)) {
    return reject(sweep, 'the base run does not hold its own assertions, so there is nothing to preserve', measured);
  }

  if (everyCandidateErrored) {
    return reject(sweep, `every candidate failed to run: ${firstError}`, measured);
  }

  // A sampled cost sweep carries a control arm at the unchanged value, and
  // the control is both the fairness and a tier boundary. Fairness: candidate
  // and control run the same tails from the same prefixes, so their means are
  // comparable where a recorded full run's is not. Boundary: a control that
  // fails any sample means the workflow is flaky at its current settings, and
  // flakiness belongs to the reliability tier — a saving measured against an
  // unreliable control credits the knob with the weather.
  const control = sweep.control ? eligible.find(c => c.name === sweep.control) : undefined;
  if (sweep.control && !control) {
    return reject(sweep, 'the control arm did not complete everywhere, so there is no cost to compare against', measured);
  }
  if (control && !control.outcomes.every(o => o.assertionsHeld && !o.error)) {
    return reject(
      sweep,
      'the unchanged value does not hold every assertion across samples — the workflow is flaky, so make it reliable before making it cheaper',
      measured,
    );
  }

  const contenders = held.filter(c => c.name !== sweep.control);
  if (contenders.length === 0) {
    return reject(sweep, 'every candidate broke an assertion the base run held', measured);
  }

  const against = control
    ? { computeMs: control.computeMs, tokens: control.tokens }
    : undefined;
  const baselineMs = against?.computeMs ?? mean(baselines.map(b => b.computeMs));
  const saving = contenders
    .map(c => ({ candidate: c, saved: delta(baselineMs, c.computeMs) }))
    .filter(entry => entry.saved >= MIN_SAVING)
    .sort((a, b) => b.saved - a.saved)[0];

  if (!saving) {
    return reject(
      sweep,
      `no candidate removed at least ${Math.round(MIN_SAVING * 100)}% of execution time without breaking an assertion`,
      measured,
    );
  }

  return { kind: 'proposal', proposal: propose(sweep, saving.candidate, baselines, measured, model, against) };
}

/** Samples an arm passed: held every assertion and actually ran. */
function passCount(candidate: Candidate): number {
  return candidate.outcomes.filter(o => o.assertionsHeld && !o.error).length;
}

/**
 * Decide a reliability sweep: does any arm pass more often than the control?
 *
 * Rates, not draws, which is what makes temperature judgeable at all: a value
 * that fails one run in five is indistinguishable from one that never fails
 * on a single draw. The comparison is exact — Fisher's one-sided test against
 * the control arm — so with five samples only a large gap can win, and the
 * rejection says what was observed rather than pretending the absence of
 * significance is the absence of difference.
 */
function decideReliability(
  sweep: KnobSweep,
  baselines: readonly BaselineOutcome[],
  eligible: readonly Candidate[],
  measured: readonly VariantOutcome[],
  model: string,
): SweepVerdict {
  const control = eligible.find(c => c.name === sweep.control);
  if (!control) {
    return reject(sweep, 'the control arm did not complete everywhere, so there is no rate to compare against', measured);
  }

  const controlPassed = passCount(control);
  const controlOf = control.outcomes.length;
  if (controlPassed === controlOf) {
    return reject(
      sweep,
      `the unreliability did not reproduce: the control held in all ${controlOf} sample(s)`,
      measured,
    );
  }

  const challengers = eligible
    .filter(c => c.name !== control.name)
    .map(candidate => {
      const passed = passCount(candidate);
      return {
        candidate,
        passed,
        pValue: fisherExactOneSided(passed, candidate.outcomes.length, controlPassed, controlOf),
      };
    });

  const significant = challengers
    .filter(entry => entry.pValue < ALPHA)
    .sort((a, b) =>
      (b.passed / b.candidate.outcomes.length) - (a.passed / a.candidate.outcomes.length)
      || a.candidate.computeMs - b.candidate.computeMs);

  const winner = significant[0];
  if (!winner) {
    const best = [...challengers].sort((a, b) => a.pValue - b.pValue)[0];
    return reject(
      sweep,
      best
        ? `no arm was distinguishably more reliable: best was ${best.passed}/${best.candidate.outcomes.length} `
          + `against the control's ${controlPassed}/${controlOf} (p=${best.pValue.toFixed(3)}, α=${ALPHA}) — `
          + 'more samples would be needed to call a gap this size'
        : 'no arm other than the control completed everywhere',
      measured,
    );
  }

  const proposal = propose(sweep, winner.candidate, baselines, measured, model, {
    computeMs: control.computeMs,
    tokens: control.tokens,
  });
  proposal.reliability = {
    winnerPassed: winner.passed,
    winnerOf: winner.candidate.outcomes.length,
    controlPassed,
    controlOf,
    pValue: winner.pValue,
  };
  return { kind: 'proposal', proposal };
}
