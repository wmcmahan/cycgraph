/**
 * Knob tuning
 *
 * The measurement half of a sweep. Enumeration and the decision rule are pure
 * and live in `@cycgraph/evals`; this drives the forks that turn candidates
 * into evidence.
 *
 * One fork per candidate per base run, taken immediately before the swept node
 * first executed. Everything earlier is replayed from the recorded log for
 * free, so the cost is the tail rather than a whole run, and every candidate
 * faces an identical prefix. That last part is the point: it is what makes two
 * candidates comparable to each other rather than to the weather.
 *
 * A fork records the same artifacts an ordinary run does, so its cost is read
 * back through the same adapter rather than measured a second way. One
 * definition of execution time, whatever produced the run.
 *
 * @module improve/tune
 */

import { z } from 'zod';
import {
  buildInsightsReport,
  buildPromptSweep,
  buildWorkflowProfile,
  computeMs,
  enumerateLeanPromptBrief,
  enumeratePromptBrief,
  enumerateSweeps,
  renderPromptBrief,
  sanitizePromptCandidates,
} from '@cycgraph/evals';
import type {
  BaselineOutcome,
  CombinationPlan,
  CombinationVerdict,
  KnobSweep,
  SweepVerdict,
  VariantOutcome,
} from '@cycgraph/evals';
import { graph, node, run, subgraph, tool } from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';
import { estimateForkSweep, forkPointsForRun, resolveAgentPrompt } from '../run/fork.js';
import {
  assembleOutcomes,
  buildMeasureGraph,
  MEASURE_ERRORS_KEY,
  MEASURE_PLAN_KEY,
  MEASURE_RESULTS_KEY,
  MEASURE_WORKER_RESULT_KEY,
} from './measure.js';
import type { MeasureArm } from './measure.js';
import {
  applyPass,
  assembleOutcome,
  initialProgress,
  nextPass,
  passSpec,
} from './tune-plan.js';
import type { Pass, PassDraw, SenseResult, TuneProgress } from './tune-plan.js';
import { findReusableDraws } from './pool.js';
import { readEpoch } from './proposals.js';
import { generatePromptCandidates } from './prompts.js';
import { isClean, loadHistory, loadTailMs } from '../run/history.js';
import { toTelemetry } from '../run/insights.js';
import type { HistoryEntry } from '../run/history.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';

/** How many base runs a sweep is measured against by default. */
const DEFAULT_PREFIXES = 2;

/** How many recorded runs are read to find findings and build the profile. */
const CORPUS_LIMIT = 500;

/** What a sweep is predicted to cost, before any of it is paid. */
export interface SweepEstimate {
  sweepId: string;
  nodeId: string;
  knob: string;
  /** Forks this sweep will run. */
  forks: number;
  /**
   * Predicted execution time, summed over every fork.
   *
   * From what the base runs spent on the same stretch of path. It is a
   * prediction and will be wrong wherever a candidate changes how much work
   * the tail does, which is the entire point of running it.
   */
  tailMs?: number;
  /** Predicted spend, which is zero for a model with no pricing. */
  costUsd: number;
  /** Per-variant estimate lines from the engine's own estimator. */
  lines: string[];
  /** Why the estimate could not be made, when it could not. */
  unavailable?: string;
}

/** What a tuning pass concluded, and what it spent getting there. */
export interface TuneOutcome {
  workflow: string;
  /** Base runs the sweeps were measured against. */
  baseRunIds: string[];
  /**
   * The model every base run and every fork used.
   *
   * A knob value is not a property of the graph alone, so a pass that cannot
   * name one model does not run at all.
   */
  model?: string;
  /** Sweeps that were enumerated, whether or not any produced a proposal. */
  sweeps: KnobSweep[];
  /** One verdict per sweep, in the order they were measured. */
  verdicts: SweepVerdict[];
  /**
   * Confirmation of each proposal against base runs the sweep never saw,
   * keyed by sweep id.
   *
   * A winner was selected on the sweep's prefixes, so its numbers carry
   * selection bias: it is the best of several candidates on that data. The
   * validation re-measures only the winner on held-out prefixes, which tests
   * the one selected hypothesis rather than re-running the contest.
   */
  validations?: Record<string, SweepVerdict>;
  /** What each sweep was predicted to cost, before it ran. */
  estimates: SweepEstimate[];
  /** Forks actually run, which is what this cost. */
  forks: number;
  /** Why nothing was measured, when nothing was. */
  skipped?: string;
  /** What happened to prompt generation, when it was asked for. */
  promptGeneration?: string;
  /** Ledger ids written when the pass was asked to save. */
  savedProposals?: string[];
  /**
   * What measuring the composed winners concluded, when a pass produced more
   * than one. Two proposals imply a third thing — both together, which is
   * what a reader will apply — and that composition is measured rather than
   * assumed.
   */
  combination?:
    | { constituents: CombinationPlan['constituents']; verdict: CombinationVerdict }
    | { skipped: string };
}

/** How to run a tuning pass. */
export interface TuneOptions {
  /** Base runs to measure against. Defaults to the most recent clean ones. */
  prefixes?: number;
  /** Report what is happening as forks complete. */
  onProgress?: (message: string) => void;
  /** Show the estimate before spending anything against it. */
  onEstimate?: (estimates: readonly SweepEstimate[]) => void;
  /** Estimate and stop, without running a single fork. */
  dryRun?: boolean;
  /** Refuse a pass predicted to run longer than this. */
  maxSeconds?: number;
  /** Refuse a pass that would run more forks than this. */
  maxForks?: number;
  /**
   * Held-out base runs to confirm each proposal against.
   *
   * Disjoint from the sweep's prefixes. A refinement found in-sample is a
   * hypothesis, not a result, and this is what turns one into the other.
   */
  validate?: number;
  /** Persist winning proposals to the ledger for review and apply. */
  save?: boolean;
  /** Skip measuring the composed winners when a pass proposes several. */
  noCombine?: boolean;
  /**
   * Reuse recorded forks as draws instead of re-running identical arms.
   *
   * Each reused draw is one past fork consumed once, so sample counts stay
   * honest. Opt-in because it assumes recorded draws are exchangeable with
   * fresh ones, and an engine change that alters sampling behaviour quietly
   * breaks that.
   */
  reuse?: boolean;
  /**
   * Arms forked at once inside each measurement pass.
   *
   * Defaults to the measure graph's own conservative cap. Worth raising when
   * the model behind the corpus can actually serve parallel tails.
   */
  concurrency?: number;
  /**
   * Draws per variant per base run, overriding what each sweep asks for.
   *
   * A reliability sweep asks for several because its verdict is a rate; a
   * budget sweep asks for one. Overriding upward buys power — the exact test
   * can only call a gap the sample size can see.
   */
  samples?: number;
  /**
   * Prompt candidates to generate for a persistently failing workflow.
   *
   * The one option that spends a model call before the estimate is shown,
   * which is why it is opt-in: everything else in a dry run is free.
   */
  prompts?: number;
  /**
   * Models to try against every node worth optimising.
   *
   * Nothing derives this. A schema bound says what a budget may be; nothing
   * says which models are installed, affordable, or allowed, so a model sweep
   * happens only when an operator names the candidates.
   */
  models?: string[];
}

/**
 * Predict what one sweep will cost across every base run it will be measured
 * against.
 *
 * Two numbers from two places, because neither alone is enough. The engine's
 * estimator resolves every variant as a dry fork, so a change that will not
 * apply is caught here rather than after the earlier variants have run; it
 * reports dollars, which are zero on a local corpus. The time comes from what
 * the base runs actually spent on the stretch of path the tail re-runs, which
 * is the unit the sweep is optimising.
 */
async function estimateOne(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  bases: readonly HistoryEntry[],
  sweep: KnobSweep,
  samples: number,
): Promise<SweepEstimate> {
  const variantCount = Object.keys(sweep.variants).length;
  const draws = variantCount * samples;
  if (bases.length === 0) {
    return {
      sweepId: sweep.id,
      nodeId: sweep.nodeId,
      knob: sweep.knob,
      forks: 0,
      costUsd: 0,
      lines: [],
      unavailable: 'no base run to fork from',
    };
  }
  const base: SweepEstimate = {
    sweepId: sweep.id,
    nodeId: sweep.nodeId,
    knob: sweep.knob,
    forks: draws * bases.length,
    costUsd: 0,
    lines: [],
  };

  let tailMs = 0;
  let timed = 0;
  for (const entry of bases) {
    const ms = await loadTailMs(entry.dir, sweep.nodeId);
    if (ms !== undefined) {
      tailMs += ms * draws;
      timed++;
    }
  }
  if (timed > 0) base.tailMs = tailMs;

  try {
    const engine = await estimateForkSweep(
      scenario, params, stack, bases[0]!.meta.runId, sweep.variants,
      { beforeNode: sweep.nodeId, occurrence: 1 },
    );
    base.costUsd = engine.costUsd * bases.length * samples;
    base.lines = engine.lines;
  } catch (err) {
    // A sweep whose variants will not resolve is worth reporting rather than
    // discovering one fork later, and the caller decides whether to proceed.
    base.unavailable = err instanceof Error ? err.message : String(err);
  }

  return base;
}

/**
 * Whether a pass exceeds a ceiling the caller set, and which one.
 *
 * Opt-in rather than defaulted. A refusal nobody asked for is a surprise, and
 * the estimate is shown either way, so the default is to inform rather than to
 * block.
 */
function refuse(
  estimates: readonly SweepEstimate[],
  options: TuneOptions,
): string | undefined {
  const forks = estimates.reduce((sum, estimate) => sum + estimate.forks, 0);
  if (options.maxForks !== undefined && forks > options.maxForks) {
    return `${forks} fork(s) exceeds the ${options.maxForks} allowed`;
  }

  if (options.maxSeconds !== undefined) {
    const seconds = estimates.reduce((sum, estimate) => sum + (estimate.tailMs ?? 0), 0) / 1000;
    if (seconds > options.maxSeconds) {
      return `predicted ${Math.round(seconds)}s exceeds the ${options.maxSeconds}s allowed`;
    }
  }

  return undefined;
}

/**
 * What one measurement session knows before any fork runs.
 *
 * Everything through the estimate — corpus, findings, enumerated sweeps,
 * the model guard, base selection, and any refusal — happens here, in one
 * call the cycle's sense node makes. The result is carried through graph
 * memory, so it holds plain data only.
 */
export async function senseTune(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  graph: Graph,
  options: TuneOptions = {},
): Promise<SenseResult> {
  const entries = await loadHistory(stack.config.artifactRoot, {
    scenarioId: scenario.id,
    limit: CORPUS_LIMIT,
  });
  // Ordinary runs only, before anything reads them: a fork is a measurement
  // about a hypothetical, and letting a sweep's own failing arms motivate the
  // next sweep is the system contaminating its own sensor. And only runs
  // since the last source write, because a finding from the retired corpus
  // would motivate a change to a workflow that no longer exists.
  const epoch = await readEpoch(stack.config.artifactRoot);
  const ordinary = entries.filter((entry) =>
    !entry.meta.parentRunId && (!epoch || entry.meta.startedAt >= epoch));
  const telemetry = await Promise.all(ordinary.map(toTelemetry));

  const report = buildInsightsReport(telemetry);
  const profile = buildWorkflowProfile(scenario.id, telemetry);
  const currentModel = stack.config.model;
  const sweeps = enumerateSweeps(report.findings, profile, graph, {
    ...(options.models?.length ? { models: options.models } : {}),
    ...(currentModel ? { currentModel } : {}),
    ...(ordinary.length > 0
      ? { cleanRunRate: ordinary.filter(isClean).length / ordinary.length }
      : {}),
  });

  // The generated tier. The brief and the sanitiser are pure and tested; the
  // generation call is the only ungated model spend in the pass, so it only
  // happens when asked for and its outcome is reported either way.
  let promptGeneration: string | undefined;
  if (options.prompts) {
    // Repair first, lean second: a broken workflow gets fixed before anything
    // gets cheaper. The lean brief needs to know what must keep passing, and
    // the recorded assertions are exactly that list.
    const checks = [...new Set(telemetry.flatMap((run) => run.assertions.map((a) => a.type)))];
    const brief = enumeratePromptBrief(report.findings, profile, graph)
      ?? enumerateLeanPromptBrief(report.findings, profile, graph, checks);
    if (!brief) {
      promptGeneration = 'neither a persistent failure nor a dominant agent node motivates a prompt rewrite';
    } else {
      const currentPrompt = await resolveAgentPrompt(scenario, params, stack, brief.nodeId);
      if (!currentPrompt) {
        promptGeneration = `'${brief.nodeId}' has no resolvable system prompt to rewrite`;
      } else {
        try {
          const raw = await generatePromptCandidates(
            stack, renderPromptBrief(brief, currentPrompt, options.prompts),
          );
          const candidates = sanitizePromptCandidates(currentPrompt, raw, options.prompts);
          const promptSweep = buildPromptSweep(brief, currentPrompt, candidates);
          if (promptSweep) {
            sweeps.push(promptSweep);
            promptGeneration = `generated ${candidates.length} candidate(s) for '${brief.nodeId}'`;
          } else {
            promptGeneration = 'the generator produced nothing that survived sanitisation';
          }
        } catch (err) {
          promptGeneration = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }

  // One model, or none. Every measurement in a pass is compared against every
  // other, and a base run made against a different model is a different
  // population: a stronger model may converge in fewer iterations and a weaker
  // one may need more, so a saving measured across a mixture belongs to
  // neither. Cheaper to refuse than to publish a proposal nothing can place.
  const models = [...new Set(entries.map((entry) => entry.meta.stack?.model).filter(Boolean))];

  const prefixCount = options.prefixes ?? DEFAULT_PREFIXES;

  // A run's artifacts outlive its event log: history survives a
  // `docker-compose down -v` and the log does not. A base run that left no
  // events cannot be forked, so the selection walks past it to the next one
  // rather than spending the whole sweep discovering it.
  const wanted = prefixCount + (options.validate ?? 0);
  const select = async (pool: HistoryEntry[]) => {
    const picked: HistoryEntry[] = [];
    for (const entry of pool) {
      if (picked.length >= wanted) break;
      const events = await stack.eventLog.loadEvents(entry.meta.runId).catch(() => []);
      if (events.length > 0) picked.push(entry);
    }
    return {
      bases: picked.slice(0, prefixCount),
      holdout: picked.slice(prefixCount, wanted),
    };
  };

  const forksFailing = (sweep: KnobSweep) =>
    sweep.prefixes === 'failing' || sweep.objective === 'correctness';

  const cleanSelection = await select(ordinary.filter(isClean));
  const failingSelection = sweeps.some(forksFailing)
    ? await select(ordinary.filter((entry) => !isClean(entry)))
    : { bases: [], holdout: [] };

  const selectionFor = (sweep: KnobSweep) =>
    forksFailing(sweep) ? failingSelection : cleanSelection;
  const usedBases = new Set(
    sweeps.flatMap((sweep) => selectionFor(sweep).bases.map((e) => e.meta.runId)),
  );

  const outcome: TuneOutcome = {
    workflow: scenario.id,
    baseRunIds: [...usedBases],
    sweeps,
    verdicts: [],
    estimates: [],
    forks: 0,
    ...(promptGeneration ? { promptGeneration } : {}),
  };

  const sense: SenseResult = {
    outcome,
    sweepData: [],
    cleanBaseRunIds: cleanSelection.bases.map((e) => e.meta.runId),
    dryRun: options.dryRun ?? false,
    reuse: options.reuse ?? false,
    noCombine: options.noCombine ?? false,
  };

  if (sweeps.length === 0) {
    outcome.skipped = epoch && ordinary.length === 0
      ? `the source changed at ${epoch} and nothing has run since — run the scenario to rebuild the corpus`
      : 'nothing this workflow recorded motivates a knob worth measuring';
    return sense;
  }
  const baseModels = [...new Set(
    ordinary.filter((e) => usedBases.has(e.meta.runId)).map((entry) => entry.meta.stack?.model).filter(Boolean),
  )];
  if (baseModels.length > 1) {
    outcome.skipped = `base runs disagree on model (${baseModels.join(', ')}), so a saving measured across them belongs to neither`;
    return sense;
  }
  outcome.model = baseModels[0] ?? models[0];

  const byRunId = new Map(telemetry.map((run) => [run.runId, run]));
  const baselineOf = (entry: HistoryEntry): BaselineOutcome => {
    const run = byRunId.get(entry.meta.runId);
    return {
      runId: entry.meta.runId,
      assertionsHeld: isClean(entry),
      computeMs: (run && computeMs(run)) ?? 0,
      tokens: run?.totalTokens ?? 0,
    };
  };

  sense.sweepData = sweeps.map((sweep) => {
    const selection = selectionFor(sweep);
    return {
      sweep,
      samples: options.samples ?? sweep.samples ?? 1,
      baseRunIds: selection.bases.map((e) => e.meta.runId),
      holdoutRunIds: selection.holdout.map((e) => e.meta.runId),
      baselines: selection.bases.map(baselineOf),
      heldOutBaselines: selection.holdout.map(baselineOf),
    };
  });

  // Estimate every sweep before running any of them, so the figure covers the
  // whole pass rather than growing one sweep at a time as it is spent.
  for (const data of sense.sweepData) {
    outcome.estimates.push(
      await estimateOne(scenario, params, stack, selectionFor(data.sweep).bases, data.sweep, data.samples),
    );
  }
  options.onEstimate?.(outcome.estimates);

  if (!sense.dryRun) {
    const refusal = refuse(outcome.estimates, options);
    if (refusal) outcome.skipped = refusal;
  }

  return sense;
}

/**
 * Pooled draws for one (base, variant) of a pass.
 *
 * The consumed set is the session's draw ledger: a recorded fork is consumed
 * at most once, so two arms with identical changes cannot both count the
 * same past draw.
 */
async function pooledDrawsFor(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  sense: SenseResult,
  draw: PassDraw,
  consumed: Set<string>,
  pointCache: Map<string, Awaited<ReturnType<typeof forkPointsForRun>>>,
): Promise<VariantOutcome[]> {
  if (!sense.reuse || !sense.outcome.model) return [];
  let points = pointCache.get(draw.baseRunId);
  if (!points) {
    points = await forkPointsForRun(scenario, params, stack, draw.baseRunId).catch(() => []);
    pointCache.set(draw.baseRunId, points);
  }
  const sequence = draw.at === 'start'
    ? points[0]?.sequenceId
    : points.find((point) => point.nodeId === (draw.at as { beforeNode: string }).beforeNode)?.sequenceId;
  if (sequence === undefined) return [];
  return findReusableDraws(stack.config.artifactRoot, scenario.id, {
    baseRunId: draw.baseRunId, forkSequenceId: sequence, changes: draw.changes, model: sense.outcome.model,
  }, draw.variant, draw.samples, consumed);
}

/** The progress line one fresh arm reports, numbered the way each pass reads best. */
function armLabel(pass: Pass, draw: PassDraw, index: number): string {
  if (pass.kind === 'validate') return draw.labelPrefix;
  if (pass.kind === 'combine') return `${draw.labelPrefix} (${index + 1}/${draw.samples})`;
  return draw.samples > 1 ? `${draw.labelPrefix} (${index + 1}/${draw.samples})` : draw.labelPrefix;
}

/**
 * Build the tune graph over one workflow.
 *
 * One cycle: `sense` establishes what to measure, `plan` picks the next
 * pass and consults the draw pool, the `measure` subgraph fans out over the
 * fresh arms, `decide` folds outcomes through the pure rules, and the cycle
 * repeats until the planner says done — main sweeps, held-out validation,
 * and the combination pass are all just passes to it. The terminal node is
 * named `tune`, so the finished `TuneOutcome` lands under `tune_result`
 * whether this graph runs standalone or embedded as a subgraph.
 */
export function buildTuneGraph(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  targetGraph: Graph | undefined,
  options: TuneOptions = {},
) {
  const pointCache = new Map<string, Awaited<ReturnType<typeof forkPointsForRun>>>();

  const senseTool = tool({
    name: 'tune_sense',
    description: 'Read the corpus, enumerate knobs, and estimate the pass.',
    parameters: z.object({}),
    timeoutMs: 0,
    execute: async (): Promise<SenseResult> => {
      const g = targetGraph ?? (await scenario.build(params as never, stack)).graph;
      return senseTune(scenario, params, stack, g, options);
    },
  });

  const planTool = tool({
    name: 'tune_plan',
    description: 'Pick the next measurement pass and consult the draw pool.',
    parameters: z.object({ sense_result: z.unknown().optional(), decide_result: z.unknown().optional() }),
    timeoutMs: 0,
    execute: async (args) => {
      const sense = args.sense_result as SenseResult;
      const progress = (args.decide_result as TuneProgress | undefined) ?? initialProgress();
      const pass = nextPass(sense, progress);
      if (!pass) return { done: true };

      const consumed = new Set(progress.consumed);
      const arms: MeasureArm[] = [];
      const pooled: VariantOutcome[] = [];
      for (const draw of passSpec(sense, pass)) {
        const drawn = await pooledDrawsFor(scenario, params, stack, sense, draw, consumed, pointCache);
        pooled.push(...drawn);
        for (let index = drawn.length; index < draw.samples; index++) {
          arms.push({
            variant: draw.variant,
            baseRunId: draw.baseRunId,
            at: draw.at,
            changes: draw.changes,
            label: armLabel(pass, draw, index),
          });
        }
      }
      return { done: false, pass, arms, pooled, consumed: [...consumed] };
    },
  });

  const decideTool = tool({
    name: 'tune_decide',
    description: "Fold the pass's outcomes through the decision rules.",
    parameters: z.object({
      sense_result: z.unknown().optional(),
      plan_result: z.unknown().optional(),
      measured_wrapped: z.unknown().optional(),
      measured_errors: z.unknown().optional(),
      decide_result: z.unknown().optional(),
    }),
    execute: (args): TuneProgress => {
      const sense = args.sense_result as SenseResult;
      const plan = args.plan_result as {
        pass: Pass; arms: MeasureArm[]; pooled: VariantOutcome[]; consumed: string[];
      };
      const progress = (args.decide_result as TuneProgress | undefined) ?? initialProgress();
      const fresh = assembleOutcomes(
        plan.arms,
        MEASURE_WORKER_RESULT_KEY,
        (args.measured_wrapped ?? []) as Array<{ index: number; updates?: Record<string, unknown> }>,
        (args.measured_errors ?? []) as Array<{ index: number; error?: string }>,
      );
      return applyPass(sense, progress, plan.pass, [...plan.pooled, ...fresh], {
        forks: plan.arms.length,
        consumed: plan.consumed,
      });
    },
  });

  const finishTool = tool({
    name: 'tune_finish',
    description: 'Assemble the finished tune outcome.',
    parameters: z.object({ sense_result: z.unknown().optional(), decide_result: z.unknown().optional() }),
    execute: (args): TuneOutcome => assembleOutcome(
      args.sense_result as SenseResult,
      (args.decide_result as TuneProgress | undefined) ?? initialProgress(),
    ),
  });

  const senseNode = node({ id: 'sense', type: 'tool', toolId: 'tune_sense', tools: [senseTool], reads: [] });
  const planNode = node({
    id: 'plan',
    type: 'tool',
    toolId: 'tune_plan',
    tools: [planTool],
    reads: [senseNode.result, 'decide_result'],
  });
  const measure = subgraph(buildMeasureGraph(scenario, params, stack, {
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }), {
    id: 'measure',
    reads: [planNode.result],
    inputs: { [planNode.result]: MEASURE_PLAN_KEY },
    outputs: { [MEASURE_RESULTS_KEY]: 'measured_wrapped', [MEASURE_ERRORS_KEY]: 'measured_errors' },
  });
  const decideNode = node({
    id: 'decide',
    type: 'tool',
    toolId: 'tune_decide',
    tools: [decideTool],
    reads: [senseNode.result, planNode.result, 'measured_wrapped', 'measured_errors', 'decide_result'],
  });
  const finishNode = node({
    id: 'tune',
    type: 'tool',
    toolId: 'tune_finish',
    tools: [finishTool],
    reads: [senseNode.result, 'decide_result'],
  });

  return graph({
    name: `tune-${scenario.id}`,
    description: 'Sense the corpus, then cycle plan, measure, decide until every pass has run.',
    nodes: [senseNode, planNode, measure, decideNode, finishNode],
    edges: [
      { from: senseNode, to: planNode },
      { from: planNode, to: measure, when: 'not memory.plan_result.done' },
      { from: planNode, to: finishNode, when: 'memory.plan_result.done' },
      { from: measure, to: decideNode },
      { from: decideNode, to: planNode },
    ],
    startNode: senseNode,
    endNodes: [finishNode],
  });
}

/**
 * Enumerate the knobs a workflow's recorded runs motivate, measure every
 * candidate, and decide what the measurements support — as one run of the
 * tune graph.
 */
export async function tuneWorkflow(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  graphArg: Graph,
  options: TuneOptions = {},
): Promise<TuneOutcome> {
  const g = buildTuneGraph(scenario, params, stack, graphArg, options);
  // The forks route their logs to their own recorders and the tools narrate
  // through onProgress, so the cycle's own engine logs stay out of the
  // terminal.
  const memory = await run(g, {
    goal: `Tune '${scenario.id}': enumerate knobs, measure candidates, decide what holds.`,
    maxIterations: 500,
  }, { runner: { logger: () => {} } });
  return memory['tune_result'] as TuneOutcome;
}
