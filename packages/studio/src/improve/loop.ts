/**
 * The self-improvement loop: run, measure, adopt, stop at a diff.
 *
 * The pieces existed separately — the watcher measures what runs produce,
 * the ladder adopts what measurement proposes — but nothing drove them,
 * so a corpus only grew when a person ran something and a proposal only
 * advanced when a person clicked. This closes the circle: it runs the
 * workflow itself until there is enough history to measure, measures,
 * and climbs as far as its autonomy allows.
 *
 * Where it stops is the point. `apply` autonomy edits source in a
 * disposable clone, verifies the rebuilt graph actually carries the
 * value, commits to a branch, and halts with the diff. Pushing and
 * merging stay human, as they always have — the loop's product is a
 * reviewable change, not a change in your repository's history.
 *
 * @module improve/loop
 */

import { executeScenario } from '../run/execute.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';
import { applyProposal, resolveApplyRepo } from './apply.js';
import { listProposals, saveProposals, setProposalStatus } from './proposals.js';
import { tuneWorkflow } from './tune.js';
import { workflowReadiness } from './watch.js';

/** How far the loop may climb without a person. */
export type LoopAutonomy = 'propose' | 'trial' | 'apply';

/** Something the loop did, as it happens. */
export interface LoopEvent {
  at: string;
  kind: 'run' | 'measure' | 'proposal' | 'trial' | 'apply' | 'idle' | 'stopped';
  message: string;
}

export interface LoopOptions {
  autonomy?: LoopAutonomy;
  /** Pause between runs the loop starts itself. @default 0 */
  cadenceMs?: number;
  /** Runs the loop may start in total. @default 20 */
  maxRuns?: number;
  /** Wall-clock ceiling. @default 30 */
  maxMinutes?: number;
  /** Forks one measurement pass may spend. */
  maxForks?: number;
  /**
   * Models the measurement may try for the workflow's dominant node.
   *
   * Without candidates a model sweep cannot be enumerated, so a workflow
   * whose only real levers are its model and prompt has nothing to
   * measure — the loop finds "nothing motivates a knob" and stops, however
   * improvable the workflow actually is.
   */
  models?: string[];
  /** Prompt candidates to generate and measure for that node. */
  prompts?: number;
  /** Runs to accrue under a trial before applying it. @default 3 */
  trialRuns?: number;
  /** Repository the apply rung writes to. Defaults to the stack's. */
  repoRoot?: string;
  onEvent?: (event: LoopEvent) => void;
  signal?: AbortSignal;
}

export interface LoopResult {
  workflow: string;
  runs: number;
  measures: number;
  /** Proposal ids this loop produced. */
  proposals: string[];
  /** The change waiting for review, when the loop got that far. */
  applied?: { id: string; branch: string; diff: string; prCommand: string; repoRoot: string; fixture: boolean };
  /** Why an apply attempt was refused, when one was. */
  applyError?: string;
  /** Why the loop returned. */
  stoppedBecause: string;
  events: LoopEvent[];
}

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_MINUTES = 30;
const DEFAULT_TRIAL_RUNS = 3;

/** Statuses that mean a proposal is still this workflow's open question. */
const OPEN = new Set(['proposed', 'trial', 'pr']);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Drive one workflow's improvement cycle to its next human decision.
 *
 * Returns when the loop produces something to review, exhausts a cap, is
 * aborted, or finds nothing worth measuring.
 */
export async function runImproveLoop(
  stack: Stack,
  workflow: Scenario,
  options: LoopOptions = {},
): Promise<LoopResult> {
  const autonomy = options.autonomy ?? 'apply';
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const deadline = Date.now() + (options.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const trialRuns = options.trialRuns ?? DEFAULT_TRIAL_RUNS;
  const artifactRoot = stack.config.artifactRoot;

  const events: LoopEvent[] = [];
  const emit = (kind: LoopEvent['kind'], message: string): void => {
    const event = { at: new Date().toISOString(), kind, message };
    events.push(event);
    options.onEvent?.(event);
  };

  const result: LoopResult = {
    workflow: workflow.id,
    runs: 0,
    measures: 0,
    proposals: [],
    stoppedBecause: 'finished',
    events,
  };

  const stop = (reason: string): LoopResult => {
    result.stoppedBecause = reason;
    emit('stopped', reason);
    return result;
  };

  const params = workflow.params.parse({});
  const runOnce = async (why: string): Promise<void> => {
    emit('run', `${why}: running ${workflow.id} (${result.runs + 1}/${maxRuns})`);
    await executeScenario(workflow, params, stack, {});
    result.runs++;
    if (options.cadenceMs) await sleep(options.cadenceMs, options.signal);
  };

  const spent = (): string | undefined => {
    if (options.signal?.aborted) return 'stopped by request';
    if (Date.now() > deadline) return 'time budget spent';
    if (result.runs >= maxRuns) return 'run budget spent';
    return undefined;
  };

  for (;;) {
    const exhausted = spent();
    if (exhausted) return stop(exhausted);

    // An open proposal is this workflow's current question; the loop
    // either advances it or hands it over, never measures past it.
    const open = (await listProposals(artifactRoot, workflow.id))
      .find((record) => OPEN.has(record.status));

    if (open?.status === 'pr') {
      return stop(`${open.id} is committed and waiting for review`);
    }

    if (open?.status === 'proposed') {
      if (autonomy === 'propose') return stop(`${open.id} is proposed and waiting for review`);
      const promoted = await setProposalStatus(artifactRoot, open.id, 'trial');
      if ('error' in promoted) return stop(promoted.error);
      emit('trial', `${open.id} on trial: ordinary runs now use it and accrue evidence`);
      continue;
    }

    if (open?.status === 'trial') {
      if (autonomy !== 'apply') return stop(`${open.id} is on trial and waiting for review`);

      // Evidence under the overlay before writing it into source: a trial
      // that nobody exercised has told us nothing new.
      const under = (await workflowReadiness(stack, [workflow]))[0];
      const accrued = under?.freshRuns ?? 0;
      if (accrued < trialRuns) {
        const budget = spent();
        if (budget) return stop(budget);
        await runOnce(`evidence under trial ${accrued + 1}/${trialRuns}`);
        continue;
      }

      const repo = options.repoRoot
        ? { root: options.repoRoot, fixture: false }
        : stack.config.applyRepo
          ? { root: stack.config.applyRepo, fixture: false }
          : await resolveApplyRepo(process.cwd(), process.cwd());

      emit('apply', `writing ${open.id} into source at ${repo.root}`);
      let outcome;
      try {
        outcome = await applyProposal(stack, repo.root, open, (line) => emit('apply', line), workflow.sourcePath);
      } catch (err) {
        // The editing session produced something the rebuild does not
        // carry — the verification gate refusing a bad edit is the system
        // working. The proposal stays on trial, where a person can retry
        // it or take it back.
        const reason = err instanceof Error ? err.message : String(err);
        result.applyError = reason;
        return stop(`could not write ${open.id} into source: ${reason}`);
      }
      result.applied = {
        id: open.id,
        branch: outcome.branch,
        diff: outcome.diff,
        prCommand: outcome.prCommand,
        repoRoot: outcome.repoRoot,
        fixture: outcome.fixture,
      };
      return stop(`committed ${open.id} to ${outcome.branch} — review the diff`);
    }

    // No open proposal: grow the corpus until it can be measured, then measure.
    const ready = (await workflowReadiness(stack, [workflow]))[0];
    if (!ready) return stop(`${workflow.id} is not in this catalog`);
    if (ready.missing.length > 0) return stop(`${workflow.id} needs ${ready.missing.join(', ')}`);

    if (!ready.ready) {
      const budget = spent();
      if (budget) return stop(budget);
      await runOnce(`corpus ${ready.freshRuns + 1}/${ready.floor}`);
      continue;
    }

    emit('measure', `measuring ${workflow.id} against ${ready.freshRuns} recorded run(s)`);
    const built = await workflow.build(params as never, stack);
    const outcome = await tuneWorkflow(workflow, params, stack, built.graph, {
      reuse: true,
      ...(options.maxForks !== undefined ? { maxForks: options.maxForks } : {}),
      ...(options.models?.length ? { models: options.models } : {}),
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
      onProgress: (message) => emit('measure', message),
    });
    result.measures++;

    const saved = await saveProposals(artifactRoot, outcome);
    result.proposals.push(...saved);

    // A pass that declined to measure is not a pass that found nothing:
    // more runs cannot satisfy a fork budget or conjure a knob, so the
    // loop stops and says what would.
    if (outcome.skipped) {
      const hint = /fork/.test(outcome.skipped) ? ' — raise the fork budget to measure it' : '';
      return stop(`${outcome.skipped}${hint}`);
    }

    if (saved.length === 0) {
      // Measured, and nothing beat the current settings. A larger corpus
      // can change that, so keep going while the budget allows.
      const budget = spent();
      if (budget) return stop(budget);
      emit('idle', 'nothing beat the current settings on this corpus');
      await runOnce('growing the corpus after a barren measurement');
      continue;
    }

    emit('proposal', `proposed ${saved.join(', ')}`);
    if (autonomy === 'propose') return stop(`${saved.join(', ')} proposed — waiting for review`);
  }
}
