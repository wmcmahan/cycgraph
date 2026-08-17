/**
 * forkEach() — one fork per variant, from one point
 *
 * `fork()` with several changes answers "does this bundle work". `forkEach()`
 * answers "which of these mattered", by running each variant against the same
 * base run at the same address so the only thing separating them is the change
 * itself.
 *
 * Every variant is paired with every other by construction: they share a base
 * run, a fork point, and a reconstructed prefix. That is what makes the
 * comparison meaningful, and it is the reason a sweep beats N unrelated runs.
 *
 * Sharing the prefix is a correctness property, not a cost saving. Replaying a
 * prefix is a pure fold over the log with no model calls, so re-deriving it per
 * variant costs microseconds. What a sweep multiplies is the tail, and tails
 * cannot be shared — they are the thing being compared.
 *
 * @module replay/fork-each
 */

import { v4 as uuidv4 } from 'uuid';
import { fork, absorbRecordedRun, type ForkOptions, type ForkResult, type ChangeInput, type ForkableRun } from './fork.js';
import { formatEstimate } from './estimate.js';
import { ForkError } from './errors.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('replay.fork-each');

/** Options for {@link forkEach}. */
export interface ForkEachOptions extends Omit<ForkOptions, 'change' | 'forkGroupId'> {
  /**
   * The variants to run, keyed by a name that identifies them in the report.
   *
   * Each value is one change or several. A variant holding several changes
   * measures that bundle, so a sweep can compare a combination against its own
   * parts in one pass.
   */
  variants: Record<string, ChangeInput>;
  /** How many variants may run at once. Defaults to 4. */
  concurrency?: number;
  /**
   * Run each variant this many times and keep every result.
   *
   * A tail is not deterministic, so one draw of one variant is an anecdote. A
   * sweep that ranks variants on single draws is ranking noise.
   */
  samples?: number;
}

/** One variant's outcome. */
export interface VariantResult {
  /** The key from `variants`. */
  name: string;
  /** Every sample run for this variant, in order. */
  samples: ForkResult[];
  /** The error that stopped this variant, when it failed. */
  error?: Error;
  /** Mean incurred spend across samples. */
  meanCostUsd: number;
  /** How many samples reached a `completed` status. */
  completed: number;
}

/** What a sweep produced. */
export interface ForkEachResult {
  /** The run every variant forked. */
  baseRunId: string;
  /** Ties these variants together in persistence. */
  forkGroupId: string;
  /** One entry per variant, in the order they were declared. */
  variants: VariantResult[];
  /** Total incurred spend across every sample of every variant. */
  totalCostUsd: number;
  /** A human-readable ranking. */
  explain(): string;
}

/** Run `tasks` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Fork a run once per variant.
 *
 * A variant that throws is recorded on its own entry rather than aborting the
 * sweep: one bad change should not discard the results of the others, which
 * have already been paid for.
 *
 * @param baseRunId The run every variant forks.
 * @param options   Variants, plus everything {@link fork} takes.
 *
 * @throws {ForkError} If no variants were given.
 */
export async function forkEach(
  base: string | ForkableRun,
  options: ForkEachOptions,
): Promise<ForkEachResult> {
  const absorbed = absorbRecordedRun(base, options as ForkOptions);
  const baseRunId = absorbed.runId;
  options = { ...absorbed.options, variants: options.variants } as ForkEachOptions;

  const names = Object.keys(options.variants);
  if (names.length === 0) {
    throw new ForkError(`forkEach(${baseRunId}): no variants given, so there is nothing to compare.`);
  }

  const { variants, concurrency = 4, samples = 1, ...forkOptions } = options;
  const forkGroupId = uuidv4();

  logger.info('sweep_started', {
    base_run_id: baseRunId,
    fork_group_id: forkGroupId,
    variants: names.length,
    samples,
  });

  // One flat work list rather than nested loops, so the concurrency limit
  // applies across the whole sweep instead of per variant.
  const work = names.flatMap(name =>
    Array.from({ length: samples }, (_, sample) => ({ name, sample })));

  const outcomes = await mapWithConcurrency(work, concurrency, async ({ name }) => {
    try {
      return {
        name,
        result: await fork(baseRunId, { ...forkOptions, change: variants[name], forkGroupId }),
      };
    } catch (error) {
      return { name, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });

  const results: VariantResult[] = names.map(name => {
    const mine = outcomes.filter(o => o.name === name);
    const ok = mine.flatMap(o => (o.result ? [o.result] : []));
    const failed = mine.find(o => o.error)?.error;

    return {
      name,
      samples: ok,
      ...(failed ? { error: failed } : {}),
      meanCostUsd: ok.length > 0
        ? ok.reduce((sum, r) => sum + r.incurredCostUsd, 0) / ok.length
        : 0,
      completed: ok.filter(r => r.state?.status === 'completed').length,
    };
  });

  const totalCostUsd = results.reduce((sum, v) => sum + v.meanCostUsd * v.samples.length, 0);

  return {
    baseRunId,
    forkGroupId,
    variants: results,
    totalCostUsd,
    explain: () => explainSweep(baseRunId, results, samples, totalCostUsd),
  };
}

/** Render a sweep as a ranked table. */
function explainSweep(
  baseRunId: string,
  variants: readonly VariantResult[],
  samples: number,
  totalCostUsd: number,
): string {
  const width = Math.max(...variants.map(v => v.name.length), 7);
  const lines = [
    `sweep of ${baseRunId.slice(0, 6)}… — ${variants.length} variant(s)` +
    `${samples > 1 ? `, ${samples} samples each` : ''}`,
  ];

  for (const v of variants) {
    const name = v.name.padEnd(width);
    if (v.error) {
      lines.push(`  ${name}  failed: ${v.error.message.split('\n')[0]}`);
      continue;
    }

    const first = v.samples[0];
    const status = samples > 1
      ? `${v.completed}/${v.samples.length} completed`
      : first?.state?.status ?? 'no result';
    const cost = `$${v.meanCostUsd.toFixed(4)}${samples > 1 ? ' mean' : ''}`;
    const path = first?.state?.visited_nodes.join(' → ') ?? '';
    lines.push(`  ${name}  ${status.padEnd(14)} ${cost.padEnd(12)} ${path}`);
  }

  lines.push(`  total     $${totalCostUsd.toFixed(4)} incurred`);
  return lines.join('\n');
}

/**
 * Predict what a sweep will cost without running it.
 *
 * Resolves every variant as a dry run, so a change that will not resolve is
 * reported here rather than after the first variants have already spent money.
 */
export async function estimateSweep(
  base: string | ForkableRun,
  options: ForkEachOptions,
): Promise<{ costUsd: number; lines: string[] }> {
  const absorbed = absorbRecordedRun(base, options as ForkOptions);
  const baseRunId = absorbed.runId;
  options = { ...absorbed.options, variants: options.variants } as ForkEachOptions;

  const names = Object.keys(options.variants);
  const samples = options.samples ?? 1;
  const { variants, ...forkOptions } = options;

  const lines: string[] = [];
  let costUsd = 0;

  for (const name of names) {
    const dry = await fork(baseRunId, {
      ...forkOptions,
      change: variants[name],
      dryRun: true,
      ignoreBudget: true,
    });
    costUsd += dry.estimate.costUsd * samples;
    lines.push(`  ${name}  ${formatEstimate(dry.estimate)}${samples > 1 ? ` × ${samples}` : ''}`);
  }

  return { costUsd, lines };
}
