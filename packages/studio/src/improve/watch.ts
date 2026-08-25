/**
 * The watch tick: one pass of the background improvement watcher
 *
 * The watcher's design splits by what each tier costs: sensing reads
 * recorded artifacts and is free; measuring runs forks and is the only
 * spend; proposing writes the ledger and is free again. A tick walks every
 * workflow and lets each tier gate the next: no fresh corpus means no
 * sensing, open proposals mean a human is already owed a decision, and
 * only what survives both gets measured — under ceilings, with the draw
 * pool making repeated ticks cheap.
 *
 * The durable output is the ledger: a proposal saved at `proposed` is the
 * park, and the existing `trial`/`apply`/`merged` commands are how a human
 * walks it. This is deliberately a one-shot so every trigger skin — the
 * CLI, a cron job, a serve-side debounce — is the same tick on a different
 * clock.
 *
 * @module improve/watch
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readEpoch, listProposals, saveProposals } from './proposals.js';
import { loadHistory } from '../run/history.js';
import { tuneWorkflow } from './tune.js';
import type { TuneOptions } from './tune.js';
import type { Scenario } from '../scenarios/types.js';
import { unmetRequirements } from '../stack/index.js';
import type { Stack } from '../stack/index.js';

/** Fresh ordinary runs a workflow needs before a tick will measure it. */
const DEFAULT_MIN_RUNS = 5;

/** Fork ceiling per tick, because a watcher spends nobody's attention. */
const DEFAULT_MAX_FORKS = 25;

/** How many recorded runs are read per workflow. */
const CORPUS_LIMIT = 500;

/** Options for {@link watchTick}. */
export interface WatchOptions {
  /** Fresh ordinary runs required before measuring. @default 5 */
  minRuns?: number;
  /** Fork ceiling across each workflow's pass. @default 25 */
  maxForks?: number;
  /** Refuse a workflow's pass predicted to run longer than this. */
  maxSeconds?: number;
  /** Estimate everything, measure nothing. */
  dryRun?: boolean;
  /** Narration as the tick unfolds. */
  onProgress?: (message: string) => void;
}

/** What one workflow's slice of a tick concluded. */
export interface WatchRow {
  workflow: string;
  outcome: 'proposed' | 'kept' | 'awaiting-review' | 'quiet' | 'skipped';
  detail: string;
  /** Forks the slice spent. */
  forks: number;
  /** Ledger ids saved, for a `proposed` row. */
  proposals: string[];
}

/** Ledger statuses that mean a human already owes this workflow a decision. */
const OPEN_STATUSES = new Set(['proposed', 'trial', 'pr']);

/** One persisted tick: when it ran and what each workflow's slice concluded. */
export interface TickRecord {
  at: string;
  rows: WatchRow[];
}

const TICKS_FILE = 'ticks.ndjsonl';

/**
 * The recorded tick history, newest first.
 *
 * Every trigger skin writes here — the CLI one-shot, a cron job, the
 * serve-side watcher — so the Improve page's tick log is the union of all
 * of them, not just what one process remembers.
 */
export async function loadTicks(artifactRoot: string, limit = 50): Promise<TickRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(artifactRoot, TICKS_FILE), 'utf8');
  } catch {
    return [];
  }
  const ticks: TickRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      ticks.push(JSON.parse(line) as TickRecord);
    } catch {
      // A truncated final line from a killed process; the rest still counts.
    }
  }
  return ticks.reverse().slice(0, limit);
}

async function recordTick(artifactRoot: string, record: TickRecord): Promise<void> {
  const path = join(artifactRoot, TICKS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

/**
 * Run one watch tick over the given workflows.
 *
 * Workflows are visited sequentially — measurement contends for the same
 * model server the runs themselves use, and a tick that makes foreground
 * work flaky has negative value.
 */
export async function watchTick(
  stack: Stack,
  scenarios: readonly Scenario[],
  options: WatchOptions = {},
): Promise<WatchRow[]> {
  const artifactRoot = stack.config.artifactRoot;
  const minRuns = options.minRuns ?? DEFAULT_MIN_RUNS;
  const rows: WatchRow[] = [];
  const epoch = await readEpoch(artifactRoot);

  for (const scenario of scenarios) {
    const row = await watchOne(stack, scenario, epoch, minRuns, options);
    rows.push(row);
    options.onProgress?.(`${scenario.id}: ${row.outcome} — ${row.detail}`);
  }

  // A dry run estimates rather than measures, and the tick log is the
  // record of what the watcher actually did.
  if (!options.dryRun) {
    await recordTick(artifactRoot, { at: new Date().toISOString(), rows });
  }

  return rows;
}

/** What a workflow needs before the watcher will measure it. */
export interface WorkflowReadiness {
  workflow: string;
  /** Runs recorded since the last corpus epoch, forks excluded. */
  freshRuns: number;
  /** Runs required before measurement begins. */
  floor: number;
  ready: boolean;
  /** Proposals already waiting on a human, which hold measurement back. */
  openProposals: string[];
  /** Stack features the workflow needs and this stack lacks. */
  missing: string[];
  /** One line saying where this workflow stands. */
  detail: string;
}

/**
 * Where each workflow stands against the gates {@link watchTick} applies,
 * computed without measuring anything. The dashboard shows this so the
 * prerequisite is visible before a tick reports it.
 */
export async function workflowReadiness(
  stack: Stack,
  scenarios: readonly Scenario[],
  options: { minRuns?: number } = {},
): Promise<WorkflowReadiness[]> {
  const floor = options.minRuns ?? DEFAULT_MIN_RUNS;
  const epoch = await readEpoch(stack.config.artifactRoot);
  const readiness: WorkflowReadiness[] = [];

  for (const scenario of scenarios) {
    const missing = unmetRequirements(stack, scenario.requires);
    const entries = await loadHistory(stack.config.artifactRoot, {
      scenarioId: scenario.id,
      limit: CORPUS_LIMIT,
    });
    const freshRuns = entries.filter((entry) =>
      !entry.meta.parentRunId && (!epoch || entry.meta.startedAt >= epoch)).length;
    const openProposals = (await listProposals(stack.config.artifactRoot, scenario.id))
      .filter((record) => OPEN_STATUSES.has(record.status))
      .map((record) => record.id);

    const detail = missing.length > 0
      ? `needs ${missing.join(', ')}`
      : openProposals.length > 0
        ? `${openProposals.length} proposal(s) awaiting review`
        : freshRuns >= floor
          ? 'ready to measure'
          : `${floor - freshRuns} more run(s) to measure`;

    readiness.push({
      workflow: scenario.id,
      freshRuns,
      floor,
      ready: missing.length === 0 && openProposals.length === 0 && freshRuns >= floor,
      openProposals,
      missing,
      detail,
    });
  }

  return readiness;
}

async function watchOne(
  stack: Stack,
  scenario: Scenario,
  epoch: string | undefined,
  minRuns: number,
  options: WatchOptions,
): Promise<WatchRow> {
  const base: Omit<WatchRow, 'outcome' | 'detail'> = {
    workflow: scenario.id,
    forks: 0,
    proposals: [],
  };

  const missing = unmetRequirements(stack, scenario.requires);
  if (missing.length > 0) {
    return { ...base, outcome: 'skipped', detail: `stack lacks ${missing.join(', ')}` };
  }

  const entries = await loadHistory(stack.config.artifactRoot, {
    scenarioId: scenario.id,
    limit: CORPUS_LIMIT,
  });
  const fresh = entries.filter((entry) =>
    !entry.meta.parentRunId && (!epoch || entry.meta.startedAt >= epoch));
  if (fresh.length === 0) {
    return { ...base, outcome: 'quiet', detail: 'no fresh runs recorded' };
  }
  if (fresh.length < minRuns) {
    return { ...base, outcome: 'quiet', detail: `${fresh.length} fresh run(s), measuring at ${minRuns}` };
  }

  const open = (await listProposals(stack.config.artifactRoot, scenario.id))
    .filter((record) => OPEN_STATUSES.has(record.status));
  if (open.length > 0) {
    return {
      ...base,
      outcome: 'awaiting-review',
      detail: `${open.map((record) => `${record.id} (${record.status})`).join(', ')}`,
    };
  }

  const params = scenario.params.parse({});
  const built = await scenario.build(params as never, stack);
  const tuneOptions: TuneOptions = {
    reuse: true,
    maxForks: options.maxForks ?? DEFAULT_MAX_FORKS,
    ...(options.maxSeconds !== undefined ? { maxSeconds: options.maxSeconds } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };

  const outcome = await tuneWorkflow(scenario, params, stack, built.graph, tuneOptions);

  if (options.dryRun) {
    const forks = outcome.estimates.reduce((sum, estimate) => sum + estimate.forks, 0);
    return {
      ...base,
      outcome: 'quiet',
      detail: outcome.skipped ?? `dry run: ${outcome.sweeps.length} sweep(s), ~${forks} fork(s) to measure`,
    };
  }
  if (outcome.skipped) {
    return { ...base, forks: outcome.forks, outcome: 'skipped', detail: outcome.skipped };
  }

  const winners = outcome.verdicts.filter((verdict) => verdict.kind === 'proposal');
  if (winners.length === 0) {
    const reason = outcome.verdicts[0]?.kind === 'rejected'
      ? outcome.verdicts[0].rejection.reason
      : 'nothing enumerated';
    return {
      ...base,
      forks: outcome.forks,
      outcome: 'kept',
      detail: `${outcome.verdicts.length} sweep(s) measured; ${reason}`,
    };
  }

  const saved = await saveProposals(stack.config.artifactRoot, outcome);
  // A resave keeps a reverted proposal reverted — the human already took
  // this change back, and the watcher re-winning the same measurement is
  // not new information. Report it as held rather than proposed, so the
  // tick log never claims a decision nobody is being asked for.
  const records = await listProposals(stack.config.artifactRoot, scenario.id);
  const active = saved.filter((id) =>
    records.find((record) => record.id === id && record.status !== 'reverted'));
  if (active.length === 0) {
    return {
      ...base,
      forks: outcome.forks,
      outcome: 'kept',
      detail: 'the winning change was reverted before, and stays reverted',
    };
  }

  const summary = winners
    .map((verdict) => `${verdict.proposal.knob} ${String(verdict.proposal.from)} → ${String(verdict.proposal.to)}`)
    .join('; ');
  return {
    ...base,
    forks: outcome.forks,
    outcome: 'proposed',
    detail: `${summary} — review with \`play proposals\``,
    proposals: active,
  };
}
