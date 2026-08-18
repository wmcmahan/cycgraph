/**
 * Knob sweeps: shared shapes
 *
 * A sweep is one knob on one node, a finite set of values to try, and a reason
 * it is worth trying them. Nothing here generates anything: a sweep is read
 * off the graph and the finding that motivated it.
 *
 * @module sweep/types
 */

import type { Change } from '@cycgraph/orchestrator';

/** A knob's value: an integer budget, or the name of a model. */
export type KnobValue = number | string;

/**
 * What a sweep is trying to achieve, which decides how its results are judged.
 *
 * The three are not symmetric. A cost sweep starts from a workflow that
 * already works and must not break it, so a failed assertion rejects the
 * candidate outright. A correctness sweep starts from one that does not work,
 * so paying more is an acceptable price and the only question is whether the
 * assertions turn green. A reliability sweep starts from one that works only
 * sometimes, so single draws say nothing and the question is whether a
 * candidate's pass *rate* beats a control arm's, tested exactly.
 */
export type SweepObjective = 'cost' | 'correctness' | 'reliability';

/** One knob, on one node, with the values worth trying. */
export interface KnobSweep {
  /**
   * Stable across passes, derived from the node and knob rather than from
   * when the sweep was proposed.
   */
  id: string;
  /** The workflow the node belongs to. */
  workflow: string;
  nodeId: string;
  /** Dotted path of what is being changed, e.g. `supervisor_config.max_iterations`. */
  knob: string;
  /**
   * The value in force today.
   *
   * Not always a number. A loop budget is an integer read off the graph; the
   * model is a name read off the run the measurements are made under.
   */
  current: KnobValue;
  objective: SweepObjective;
  /**
   * Which recorded runs the sweep forks.
   *
   * Clean runs when the sweep must preserve something that works, failing
   * runs when the failure has to be present for its absence to mean
   * anything. Absent means clean, except for correctness sweeps, which are
   * failing by definition.
   */
  prefixes?: 'clean' | 'failing';
  /** Why this is worth measuring, taken from what motivated it. */
  reason: string;
  /** One entry per candidate value, keyed by a label naming the value. */
  variants: Record<string, Change[]>;
  /**
   * The variant that changes nothing, for a reliability sweep.
   *
   * Rates need a fair comparison, and history is not one: recorded runs
   * failed wherever they failed, while a fork resamples only the tail. The
   * control resamples the same tail from the same prefixes at the current
   * value, so the only thing separating the arms is the knob.
   */
  control?: string;
  /**
   * Draws per variant per base run.
   *
   * One for a budget sweep, where the verdict is a constraint plus a size.
   * Several for a reliability sweep, where one draw of a flaky tail is an
   * anecdote and the verdict is a rate.
   */
  samples?: number;
}

/** What one candidate did when it was actually run. */
export interface VariantOutcome {
  /** The key from `KnobSweep.variants`. */
  name: string;
  /** Run id of the fork, so a reader can open what was measured. */
  runId?: string;
  /** Whether every assertion the workflow declares held. */
  assertionsHeld: boolean;
  /** Assertions that did not hold, for a reader deciding whether to care. */
  failed: string[];
  /** Time the variant spent executing nodes. */
  computeMs: number;
  /** Tokens the variant spent. */
  tokens: number;
  /** What stopped it, when it did not finish. */
  error?: string;
  /**
   * True when this draw came from a recorded fork rather than a fresh one.
   *
   * A reused draw is one past measurement consumed once, never one
   * measurement replayed as several: the distinction between memoizing a
   * pool of samples and manufacturing certainty from a single observation.
   */
  reused?: boolean;
}

/** The base run a sweep was measured against. */
export interface BaselineOutcome {
  runId: string;
  assertionsHeld: boolean;
  computeMs: number;
  tokens: number;
}

/** A change that was measured and is worth making. */
export interface SweepProposal {
  /** The sweep it came from. */
  sweepId: string;
  workflow: string;
  nodeId: string;
  knob: string;
  /** The value in force before the change. */
  from: KnobValue;
  /** The value that won. */
  to: KnobValue;
  objective: SweepObjective;
  /**
   * The model every base run and every fork used.
   *
   * A knob value is not a property of the graph alone. A stronger model may
   * converge in fewer iterations and a weaker one may need more, so a saving
   * measured here transfers to another model only as a hypothesis. Recording
   * it is what lets a later pass tell a stale proposal from a current one.
   */
  model: string;
  /** The change to apply, ready to hand to `fork()` again or to an author. */
  change: Change[];
  /** Fraction of execution time removed. Negative when the winner costs more. */
  computeDelta: number;
  /** Fraction of tokens removed. Negative when the winner costs more. */
  tokenDelta: number;
  /** Base runs it held across, which is what makes it more than an anecdote. */
  measuredOn: string[];
  /** The rate comparison behind a reliability proposal. */
  reliability?: {
    /** Samples the winner passed, over samples it ran. */
    winnerPassed: number;
    winnerOf: number;
    /** Samples the control passed, over samples it ran. */
    controlPassed: number;
    controlOf: number;
    /** One-sided exact probability of the winner's edge under no difference. */
    pValue: number;
  };
  /** Every candidate's outcome, so the proposal shows its working. */
  outcomes: VariantOutcome[];
}

/** Why a sweep produced no proposal, which is the usual result. */
export interface SweepRejection {
  sweepId: string;
  workflow: string;
  nodeId: string;
  knob: string;
  reason: string;
  outcomes: VariantOutcome[];
}

/** What a sweep concluded. */
export type SweepVerdict =
  | { kind: 'proposal'; proposal: SweepProposal }
  | { kind: 'rejected'; rejection: SweepRejection };
