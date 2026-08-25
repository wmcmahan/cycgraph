/**
 * The tune pass planner: the sweep loops as a pure state machine
 *
 * `tuneWorkflow`'s measurement section used to be three sequential driver
 * loops — main sweeps, held-out validation, combination. As a graph, those
 * loops become one cycle (plan → measure → decide → plan), and this module
 * is the pure core the cycle's tools call: given what sensing found and
 * what has been decided so far, which pass runs next, what arms it needs,
 * and how its outcomes fold into progress. No IO and no clock, so every
 * branch of the ladder's control flow is unit-testable without a fork.
 *
 * The decision rules themselves stay in `@cycgraph/evals`; this module only
 * sequences them.
 *
 * @module improve/tune-plan
 */

import {
  decideCombination,
  decideSweep,
  planCombination,
} from '@cycgraph/evals';
import type {
  BaselineOutcome,
  CombinationPlan,
  KnobSweep,
  VariantOutcome,
} from '@cycgraph/evals';
import type { Change, ForkPoint } from '@cycgraph/orchestrator';
import type { TuneOutcome } from './tune.js';

/** Everything the planner needs about one enumerated sweep. */
export interface SweepPlanData {
  sweep: KnobSweep;
  /** Draws per variant per base, after any override. */
  samples: number;
  baseRunIds: string[];
  holdoutRunIds: string[];
  baselines: BaselineOutcome[];
  heldOutBaselines: BaselineOutcome[];
}

/** What sensing concluded, carried into the cycle through memory. */
export interface SenseResult {
  /** The outcome so far: sweeps, estimates, model, skip reasons. */
  outcome: TuneOutcome;
  sweepData: SweepPlanData[];
  /** Base runs the combination pass forks from the start. */
  cleanBaseRunIds: string[];
  dryRun: boolean;
  reuse: boolean;
  noCombine: boolean;
}

/** One measurement pass of the cycle. */
export type Pass =
  | { kind: 'main'; sweepIndex: number }
  | { kind: 'validate'; sweepIndex: number; narrowed: KnobSweep }
  | { kind: 'combine'; plan: CombinationPlan; bundleSweep: KnobSweep };

/** What the cycle has decided so far. */
export interface TuneProgress {
  verdicts: TuneOutcome['verdicts'];
  validations: Record<string, TuneOutcome['verdicts'][number]>;
  combination?: TuneOutcome['combination'];
  /** Forks actually run. */
  forks: number;
  /** Draw-pool keys consumed by this session, so no draw counts twice. */
  consumed: string[];
  nextSweepIndex: number;
  pendingValidation?: { sweepIndex: number; narrowed: KnobSweep };
  combinationConsidered: boolean;
}

/** One fork the current pass needs measured, before pooling. */
export interface PassDraw {
  variant: string;
  baseRunId: string;
  at: ForkPoint;
  changes: Change[];
  samples: number;
  labelPrefix: string;
}

/** A fresh session's progress. */
export function initialProgress(): TuneProgress {
  return {
    verdicts: [],
    validations: {},
    forks: 0,
    consumed: [],
    nextSweepIndex: 0,
    combinationConsidered: false,
  };
}

/**
 * The pass the cycle runs next, or `undefined` when it is done.
 *
 * Validation preempts the next sweep so a proposal is confirmed while its
 * held-out prefixes are still the freshest thing known about it; the
 * combination pass runs once, after every sweep has decided.
 */
export function nextPass(sense: SenseResult, progress: TuneProgress): Pass | undefined {
  if (sense.outcome.skipped || sense.dryRun) return undefined;

  if (progress.pendingValidation) {
    return { kind: 'validate', ...progress.pendingValidation };
  }
  if (progress.nextSweepIndex < sense.sweepData.length) {
    return { kind: 'main', sweepIndex: progress.nextSweepIndex };
  }
  if (!progress.combinationConsidered && !sense.noCombine) {
    const sweeps = sense.sweepData.map(d => d.sweep);
    const plan = planCombination(sweeps, progress.verdicts);
    if (plan && !('skipped' in plan)) {
      return {
        kind: 'combine',
        plan,
        bundleSweep: {
          id: `sweep:${sense.outcome.workflow}:combined`,
          workflow: sense.outcome.workflow,
          nodeId: plan.constituents[0]!.nodeId,
          knob: 'combined',
          current: 'apart',
          objective: 'cost',
          reason: 'two winners imply both together, which no single sweep measured',
          variants: { control: [], bundle: plan.changes },
          samples: plan.samples,
        },
      };
    }
  }
  return undefined;
}

/** The draws a pass needs, one entry per (base, variant). */
export function passSpec(sense: SenseResult, pass: Pass): PassDraw[] {
  if (pass.kind === 'combine') {
    return sense.cleanBaseRunIds.flatMap(baseRunId =>
      (['control', 'bundle'] as const).map(variant => ({
        variant,
        baseRunId,
        at: 'start' as const,
        changes: pass.bundleSweep.variants[variant]!,
        samples: pass.plan.samples,
        labelPrefix: `combine ${variant} from ${baseRunId.slice(0, 8)}`,
      })),
    );
  }

  const data = sense.sweepData[pass.sweepIndex]!;
  const sweep = pass.kind === 'validate' ? pass.narrowed : data.sweep;
  const baseRunIds = pass.kind === 'validate' ? data.holdoutRunIds : data.baseRunIds;
  const prefix = pass.kind === 'validate' ? 'validate ' : '';

  return baseRunIds.flatMap(baseRunId =>
    Object.entries(sweep.variants).map(([variant, changes]) => ({
      variant,
      baseRunId,
      at: { beforeNode: data.sweep.nodeId, occurrence: 1 } as ForkPoint,
      changes,
      samples: data.samples,
      labelPrefix: `${prefix}${data.sweep.nodeId} ${variant} from ${baseRunId.slice(0, 8)}`,
    })),
  );
}

/** Fold one pass's measured outcomes into progress. */
export function applyPass(
  sense: SenseResult,
  progress: TuneProgress,
  pass: Pass,
  outcomes: VariantOutcome[],
  spent: { forks: number; consumed: string[] },
): TuneProgress {
  const next: TuneProgress = {
    ...progress,
    forks: progress.forks + spent.forks,
    consumed: spent.consumed,
  };

  if (pass.kind === 'main') {
    const data = sense.sweepData[pass.sweepIndex]!;
    const verdict = decideSweep(
      { ...data.sweep, samples: data.samples },
      data.baselines,
      outcomes,
      sense.outcome.model,
    );
    next.verdicts = [...progress.verdicts, verdict];
    next.nextSweepIndex = pass.sweepIndex + 1;

    if (verdict.kind === 'proposal' && data.holdoutRunIds.length > 0) {
      const winnerName = Object.entries(data.sweep.variants)
        .find(([, change]) => change === verdict.proposal.change)?.[0];
      if (winnerName) {
        next.pendingValidation = {
          sweepIndex: pass.sweepIndex,
          narrowed: {
            ...data.sweep,
            samples: data.samples,
            variants: {
              ...(data.sweep.control
                ? { [data.sweep.control]: data.sweep.variants[data.sweep.control]! }
                : {}),
              [winnerName]: data.sweep.variants[winnerName]!,
            },
          },
        };
      }
    }
    return next;
  }

  if (pass.kind === 'validate') {
    const data = sense.sweepData[pass.sweepIndex]!;
    next.validations = {
      ...progress.validations,
      [data.sweep.id]: decideSweep(pass.narrowed, data.heldOutBaselines, outcomes, sense.outcome.model),
    };
    const { pendingValidation: _done, ...rest } = next;
    return rest;
  }

  const control = outcomes.filter(o => o.name === 'control');
  const bundle = outcomes.filter(o => o.name === 'bundle');
  next.combination = {
    constituents: pass.plan.constituents,
    verdict: decideCombination(pass.plan, control, bundle),
  };
  next.combinationConsidered = true;
  return next;
}

/**
 * The finished outcome: what sensing established plus what the cycle
 * decided. The combination-skipped note is recomputed here because a
 * cycle that never ran a combine pass still owes the reader the reason.
 */
export function assembleOutcome(sense: SenseResult, progress: TuneProgress): TuneOutcome {
  const outcome: TuneOutcome = {
    ...sense.outcome,
    verdicts: progress.verdicts,
    forks: progress.forks,
    ...(Object.keys(progress.validations).length > 0 ? { validations: progress.validations } : {}),
  };
  if (progress.combination) {
    outcome.combination = progress.combination;
  } else if (!sense.noCombine && !sense.dryRun && !sense.outcome.skipped) {
    const plan = planCombination(sense.sweepData.map(d => d.sweep), progress.verdicts);
    if (plan && 'skipped' in plan) outcome.combination = plan;
  }
  return outcome;
}
